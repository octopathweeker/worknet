import {recoverAuthorizationAddress} from 'viem/utils';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createPublicClient,createWalletClient,http,keccak256,encodeFunctionData,recoverTypedDataAddress,parseTransaction,recoverTransactionAddress,formatEther,parseEther,type Hex,type Address} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {monadTestnet} from 'viem/chains';
import {taskManagerAbi} from '@agent-task/contracts';
import {delegationStatusAbi,accountEnvironment,agentSessionPermission,permissionTypedData,hashDelegation,redeemPermission,isSupportedDelegation,delegatedImplementation,AGENT_SESSION_CALLS,type AgentSessionGrant} from '@agent-task/accounts';
import {hashJson,validateTaskSpec,assertTaskSpecBinding} from '@agent-task/protocol';
import {TakerClient,TakerApiError} from './client.js';

const MAX_GAS_COST=parseEther('0.2'),MAX_ACTIVATION_GAS_COST=parseEther('0.25');
async function atomicJson(path:string,value:unknown){const tmp=`${path}.${crypto.randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(value),{mode:0o600,flag:'wx'});await rename(tmp,path);}
/** Serializes all transactions for one local signer, including across CLI/MCP processes. */
export async function withAgentLock<T>(path:string,fn:()=>Promise<T>):Promise<T>{
  const lock=`${path}.tx-lock`;await mkdir(dirname(path),{recursive:true,mode:0o700});
  for(let i=0;;i++){
    try{await mkdir(lock,{mode:0o700});await writeFile(`${lock}/pid`,String(process.pid),{mode:0o600,flag:'wx'});break;}
    catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      const pid=Number(await readFile(`${lock}/pid`,'utf8').catch(()=>''));
      if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH'){await rm(lock,{recursive:true});continue;}}}
      if(i>=20)throw new Error('Another Agent transaction is in progress; retry the same operation.');await sleep(250);
    }
  }
  try{return await fn();}finally{await rm(lock,{recursive:true,force:true});}
}

export class AgentClient extends TakerClient {
  private readonly signer;
  constructor(origin:string,token:string,key:Hex,private readonly executorId:string,private readonly path:string,signal?:AbortSignal){super(origin,token,signal);this.signer=privateKeyToAccount(key);}
  private async context(){
    const status=await this.request('/me');const grant=status.grant as AgentSessionGrant|undefined;
    if(!status.approved||!grant?.approved)throw new Error('PASSKEY_APPROVAL_REQUIRED: open the original approval URL and finish initial authorization.');
    if(grant.id!==this.executorId||grant.chainId!==10143||grant.owner.toLowerCase()!==status.owner||grant.signer.toLowerCase()!==this.signer.address.toLowerCase()||grant.maxCalls!==AGENT_SESSION_CALLS||grant.validUntil*1000<=Date.now())throw new Error('AGENT_GRANT_INVALID');
    const expected=agentSessionPermission(grant.owner,this.signer.address,grant.manager,grant.id,grant.validUntil);
    if(hashDelegation(expected)!==hashDelegation(grant.permission)||(await recoverTypedDataAddress({...permissionTypedData(expected),signature:grant.permission.signature})).toLowerCase()!==grant.owner.toLowerCase())throw new Error('AGENT_GRANT_INVALID');
    const response=await fetch(`${this.origin}/platform/config`,{redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('Config unavailable');const config=await response.json() as any;
    if(config.manager.toLowerCase()!==grant.manager.toLowerCase()||config.token.toLowerCase()!==grant.token.toLowerCase())throw new Error('Platform contracts changed; human authorization is required.');
    const rpc=new URL(config.rpcWalletUrl);if(rpc.protocol!=='https:'&&!(rpc.protocol==='http:'&&['localhost','127.0.0.1'].includes(rpc.hostname)))throw new Error('Invalid RPC');
    const client=createPublicClient({chain:monadTestnet,transport:http(rpc.href,{timeout:15000,retryCount:0}),pollingInterval:1000});if(await client.getChainId()!==10143)throw new Error('Wrong chain');
    const wallet=createWalletClient({account:this.signer,chain:monadTestnet,transport:http(rpc.href,{timeout:15000,retryCount:0})});
    const hash=hashDelegation(grant.permission);
    const [disabled,used]=await Promise.all([client.readContract({address:accountEnvironment.DelegationManager,abi:delegationStatusAbi,functionName:'disabledDelegations',args:[hash]}),client.readContract({address:accountEnvironment.caveatEnforcers.LimitedCallsEnforcer!,abi:delegationStatusAbi,functionName:'callCounts',args:[accountEnvironment.DelegationManager,hash]})]);
    return {client,wallet,grant,status,disabled,remaining:Math.max(0,AGENT_SESSION_CALLS-Number(used)),storageUrl:config.storageUrl??this.origin};
  }
  override async status(){
    const accountUrl=`${this.origin}/#/taker/executors/${this.executorId}`;
    let status;try{status=await this.request('/me');}catch(error){if(error instanceof TakerApiError&&error.status===401)return {authorized:false,state:'access-unavailable',accountUrl,gasAddress:this.signer.address,next:'Open accountUrl with the original Mera Passkey to inspect the account. If the grant expired or was revoked, use renew; do not create another wallet or delete this config.'};throw error;}
    if(!status.approved)return {...status,accountUrl,gasAddress:this.signer.address,next:'Complete the first Passkey approval using the original approval URL.'};
    const {client,grant,disabled,remaining}=await this.context();const gas=await client.getBalance({address:this.signer.address});
    return {...status,accountUrl,gasAddress:this.signer.address,rewardAddress:grant.owner,gasBalanceMON:formatEther(gas),chainRevoked:disabled,remainingCalls:remaining,maxGasPerTransactionMON:'0.2',maxActivationGasMON:'0.25',faucet:'https://faucet.monad.xyz/',next:disabled?'On-chain authority revoked; human reauthorization is required.':remaining<2?'Insufficient call allowance for a new task; human reauthorization is required.':gas===0n?'Fund gasAddress with test MON, then use take TASK_ID. No USDC budget deposit is needed.':'Ready to take tasks within the grant.'};
  }
  override async take(taskId:string){const {disabled,remaining}=await this.context();if(disabled)throw new Error('AGENT_GRANT_REVOKED');if(remaining<2)throw new Error('AGENT_CALL_LIMIT');return super.take(taskId);}
  override claim(id:string){return this.execute(id,'claim');}
  override submit(id:string){return this.execute(id,'submit');}
  private async execute(id:string,phase:'claim'|'submit'){
    if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('Invalid run ID');
    return withAgentLock(this.path,async()=>{
      const {client,wallet,grant,storageUrl,disabled,remaining}=await this.context();const run=await this.run(id);
      if(run.mode!=='agent')return phase==='claim'?super.claim(id):super.submit(id);
      if(run.executorId!==grant.id||run.owner.toLowerCase()!==grant.owner.toLowerCase()||run.revoked||run.superseded||!run.authorized||run.validUntil*1000<=Date.now())throw new Error('GRANT_EXPIRED');
      const spec=validateTaskSpec(run.spec);const task=await client.readContract({address:grant.manager,abi:taskManagerAbi,functionName:'getTask',args:[BigInt(run.taskId)],blockTag:'finalized'});
      assertTaskSpecBinding(spec,{settlementChainId:'10143',taskManager:grant.manager.toLowerCase(),requester:task.requester.toLowerCase(),clientRequestId:spec.clientRequestId,settlementToken:grant.token.toLowerCase(),params:task});
      if(hashJson(spec)!==task.specHash)throw new Error('SPEC_MISMATCH');
      const own=task.worker.toLowerCase()===grant.owner.toLowerCase()&&String(task.attempt)===run.attempt;
      if(own&&((phase==='claim'&&task.status>=1)||(phase==='submit'&&task.status>=2&&task.resultHash===run.resultHash)))return {status:'confirmed',taskId:run.taskId,attempt:run.attempt};
      const head=await client.getBlock({blockTag:'finalized'});
      if(phase==='claim'?(task.status!==0||String(task.attempt+1n)!==run.attempt||task.taskDeadline<=head.timestamp+30n):(!own||task.status!==1||task.claimLeaseExpiresAt<=head.timestamp||!run.resultHash))throw new Error('TASK_UNAVAILABLE');
      if(disabled)throw new Error('AGENT_GRANT_REVOKED');if(remaining<(phase==='claim'?2:1))throw new Error('AGENT_CALL_LIMIT');
      const command=await this.request(`/runs/${id}/${phase}`,{});if(!command.agentRequired)throw new Error('AGENT_GRANT_REQUIRED');
      // Construct calldata locally. The API can never substitute a recipient, method or value.
      const callData=phase==='claim'?encodeFunctionData({abi:taskManagerAbi,functionName:'claimTask',args:[BigInt(run.taskId)]}):encodeFunctionData({abi:taskManagerAbi,functionName:'submitResult',args:[BigInt(run.taskId),BigInt(run.attempt),run.resultHash,`${storageUrl}/objects/${run.resultHash}`]});
      const call={target:grant.manager,value:0n,callData};
      if(command.call.target.toLowerCase()!==grant.manager.toLowerCase()||BigInt(command.call.value)!==0n||command.call.callData!==callData)throw new Error('CALL_MISMATCH');
      const tx=redeemPermission(grant.permission,[call]);const journalPath=`${this.path}.${id}.${phase}.tx.json`;
      let journal:{raw:Hex;hash:Hex}|undefined;
      try{journal=JSON.parse(await readFile(journalPath,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      if(!journal){
        const code=await client.getCode({address:grant.owner});let authorizationList;
        if(!isSupportedDelegation(code)){
          if(code&&code!=='0x')throw new Error('Account delegation changed; human recovery is required.');
          const auth=grant.authorization;
          if(!auth||auth.chainId!==10143||auth.address.toLowerCase()!==delegatedImplementation.toLowerCase()||auth.nonce!==await client.getTransactionCount({address:grant.owner,blockTag:'pending'})||(await recoverAuthorizationAddress({authorization:auth as any})).toLowerCase()!==grant.owner.toLowerCase())throw new Error('Account activation expired; reopen onboarding and confirm with the Passkey.');
          authorizationList=[auth as any];
        }
        const latest=await client.getTransactionCount({address:this.signer.address,blockTag:'latest'}),pending=await client.getTransactionCount({address:this.signer.address,blockTag:'pending'});
        if(latest!==pending)throw new Error('A previous Agent transaction is pending; resume it before sending another.');
        const balance=await client.getBalance({address:this.signer.address});if(balance===0n)throw new Error(`GAS_REQUIRED: fund ${this.signer.address} with test MON. https://faucet.monad.xyz/`);
        const prepared=await wallet.prepareTransactionRequest({...tx,value:0n,nonce:latest,...(authorizationList?{authorizationList}:{})});
        const cost=prepared.gas*(prepared.maxFeePerGas??prepared.gasPrice??0n);
        const cap=authorizationList?MAX_ACTIVATION_GAS_COST:MAX_GAS_COST;
        if(cost>cap)throw new Error(`GAS_LIMIT: estimated ${formatEther(cost)} test MON exceeds ${formatEther(cap)}; wait for lower fees. No transaction was signed.`);
        if(balance<cost)throw new Error(`GAS_REQUIRED: estimated ${formatEther(cost)} test MON, available ${formatEther(balance)}. Top up ${this.signer.address}; no transaction was signed.`);
        const raw=await wallet.signTransaction(prepared);journal={raw,hash:keccak256(raw)};await atomicJson(journalPath,journal);
      }
      const parsed=parseTransaction(journal.raw);
      if(keccak256(journal.raw)!==journal.hash||(await recoverTransactionAddress({serializedTransaction:journal.raw as any})).toLowerCase()!==this.signer.address.toLowerCase()||parsed.chainId!==10143||parsed.to?.toLowerCase()!==tx.to.toLowerCase()||parsed.data!==tx.data||(parsed.value??0n)!==0n)throw new Error('TRANSACTION_JOURNAL_MISMATCH');
      // Re-broadcast only the identical signed bytes after a timeout/crash.
      let receipt=await client.getTransactionReceipt({hash:journal.hash}).catch(()=>null);
      if(!receipt){try{await client.sendRawTransaction({serializedTransaction:journal.raw as any});}catch{/* Receipt resolves an uncertain send. */}receipt=await client.waitForTransactionReceipt({hash:journal.hash,timeout:45000});}
      if(receipt.status!=='success')throw new Error(`TRANSACTION_REVERTED: ${journal.hash}; inspect the original transaction, no replacement was sent.`);
      return {status:'confirmed',hash:journal.hash,taskId:run.taskId,attempt:run.attempt};
    });
  }
}
