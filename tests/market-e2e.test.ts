import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {readFileSync} from 'node:fs';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {createPublicClient,createWalletClient,http,erc20Abi,bytesToHex,keccak256,stringToHex,encodeFunctionData,type Address,type Hex} from 'viem';
import {monadTestnet} from 'viem/chains';
import {mnemonicToAccount} from 'viem/accounts';
import {factoryAbi,delegatedImplementation,permissionTypedData,redeemPermission} from '@agent-task/accounts';
import {taskManagerAbi,requesterVaultAbi} from '@agent-task/contracts';
import {PlatformCoordinator} from '../apps/object-store/src/platform-coordinator.js';
import {platformApi} from '../apps/object-store/src/platform-api.js';
import {takerApi} from '../apps/object-store/src/taker-api.js';
import type {Env} from '../apps/object-store/src/index.js';

test('R6 local-chain failure matrix: sponsor outage, wallet recovery, wrong result, reviewer outage, lease and unattended expiry', {timeout:150000}, async()=>{
 const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
 const anvil=spawn('.tools/foundry/anvil',['--network','monad','--hardfork','MonadNine','--chain-id','10143','--port',String(port),'--silent'],{stdio:'ignore'});
 const rpc=`http://127.0.0.1:${port}`;const nativeFetch=globalThis.fetch;
 const client=createPublicClient({chain:monadTestnet,transport:http(rpc),pollingInterval:50});
 const accounts=Array.from({length:5},(_,addressIndex)=>mnemonicToAccount('test test test test test test test test test test test junk',{addressIndex}));const [sponsor,operator,platformWorker,requester,taker]=accounts as [typeof accounts[0],typeof accounts[0],typeof accounts[0],typeof accounts[0],typeof accounts[0]];
 const wallets=accounts.map(account=>createWalletClient({chain:monadTestnet,account,transport:http(rpc)}));
 const db=new DatabaseSync(':memory:');db.exec(readFileSync('apps/object-store/schema.sql','utf8'));db.exec(readFileSync('apps/object-store/platform-schema.sql','utf8'));
 try{
  for(let i=0;;i++){try{await client.getChainId();break;}catch{if(i>40)throw new Error('startup');await new Promise(r=>setTimeout(r,100));}}
  const raw=async(method:string,params:unknown[])=>{const response=await nativeFetch(rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const value=await response.json() as any;if(value.error)throw new Error(JSON.stringify(value.error));return value.result;};
  const fixture=JSON.parse(readFileSync('tests/fixtures/7702-deployments.json','utf8'));for(const entry of Object.values(fixture.contracts) as any[])await raw('anvil_setCode',[entry.address,entry.code]);
  await raw('anvil_setCode',[taker!.address,`0xef0100${delegatedImplementation.slice(2)}`]);
  async function deploy(name:string,args:unknown[]=[]){const artifact=JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`,'utf8'));const hash=await wallets[0]!.deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object,args});return (await client.waitForTransactionReceipt({hash})).contractAddress!;}
  const testJudges=['0x1111111111111111111111111111111111111111','0x2222222222222222222222222222222222222222'];
const token=await deploy('MockUSDC');const manager=await deploy('TaskManager',[token,testJudges,1]);const factory=await deploy('RequesterVaultFactory',[manager,token]);
  const receipt=async(hash:Hex)=>{const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r;};
  await receipt(await wallets[0]!.writeContract({address:token,abi:[...erc20Abi,{type:'function',name:'mint',stateMutability:'nonpayable',inputs:[{type:'address',name:'to'},{type:'uint256',name:'amount'}],outputs:[]}],functionName:'mint',args:[requester!.address,1000000n]}));
  await receipt(await wallets[3]!.writeContract({address:factory,abi:factoryAbi,functionName:'createVault',args:[requester!.address]}));const vault=await client.readContract({address:factory,abi:factoryAbi,functionName:'vaultOf',args:[requester!.address]});
  await receipt(await wallets[3]!.writeContract({address:token,abi:erc20Abi,functionName:'approve',args:[vault,500000n]}));await receipt(await wallets[3]!.writeContract({address:vault,abi:requesterVaultAbi,functionName:'deposit',args:[500000n]}));
  await receipt(await wallets[3]!.writeContract({address:vault,abi:requesterVaultAbi,functionName:'authorizeAgent',args:[operator!.address,{validAfter:0n,validUntil:(await client.getBlock()).timestamp+86400n,maxPerTask:200000n,maxTotalCommitment:500000n}]}));
  globalThis.fetch=async(input,init)=>{if(!String(input).startsWith('https://taker-rpc.test'))return nativeFetch(input,init);const p=JSON.parse(String(init?.body));if(p.method==='eth_call'&&p.params[1]==='finalized')p.params[1]='latest';if(p.method==='eth_getBlockByNumber'&&p.params[0]==='finalized')p.params[0]='latest';return nativeFetch(rpc,{...init,body:JSON.stringify(p)});};
  const memory=new Map<string,unknown>();let crash=false,crashed=false;
  const ctx={storage:{async get(key:string){return structuredClone(memory.get(key));},async list(o:any){return new Map([...memory.entries()].filter(([k])=>k.startsWith(o.prefix)&&(!o.startAfter||k>o.startAfter)).sort().slice(0,o.limit));},async put(key:string|Record<string,unknown>,value?:unknown){const entries=typeof key==='string'?[[key,value] as const]:Object.entries(key);if(crash&&entries.some(([k,v])=>k.startsWith('tx:sponsor:taker-claim:')&&(v as any)?.status==='confirmed')){crash=false;crashed=true;throw new Error('simulated death after external claim mined');}for(const [k,v]of entries)memory.set(k,structuredClone(v));},async delete(k:string){memory.delete(k);},async getAlarm(){return null;},async setAlarm(_value:number){}}};
  let coordinator:PlatformCoordinator;
  const env:Env={PLATFORM_CONFIG:JSON.stringify({chainId:10143,manager,token,factory,operator:operator!.address,worker:platformWorker!.address,sponsor:sponsor!.address,rpcUrl:'https://taker-rpc.test',storageUrl:'https://platform.test',deploymentBlock:'0'}),PLATFORM_OPERATOR_KEY:bytesToHex(operator!.getHdKey().privateKey!),PLATFORM_WORKER_KEY:bytesToHex(platformWorker!.getHdKey().privateKey!),PLATFORM_SPONSOR_KEY:bytesToHex(sponsor!.getHdKey().privateKey!),PLATFORM:{idFromName:()=>1,get:()=>({fetch:(u:string,i:RequestInit)=>coordinator.fetch(new Request(u,i))})}as any,DB:{prepare(sql){let args:SQLInputValue[]=[];return{bind(...v){args=v as SQLInputValue[];return this;},async first<T>(){return(db.prepare(sql).get(...args)??null)as T|null;},async run(){return db.prepare(sql).run(...args);}};}}};
  coordinator=new PlatformCoordinator(ctx as any,env);
  async function call(path:string,body?:unknown,cookie='',bearer=''){const request=new Request(`https://platform.test/platform/${path}`,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{origin:'https://platform.test','content-type':'application/json',cookie,...(bearer?{authorization:`Bearer ${bearer}`}:{})}});return path.startsWith('taker/')?takerApi(request,env):platformApi(request,env);}
  async function ok(path:string,body?:unknown,cookie='',bearer=''){const r=await call(path,body,cookie,bearer);const value=await r.json() as any;assert(r.ok,JSON.stringify(value));return value;}
  async function login(i:number){const account=accounts[i]!;const c=await ok('auth/challenge',{address:account.address});const r=await call('auth/verify',{id:c.id,signature:await account.signMessage({message:c.message})});assert(r.ok);return r.headers.get('set-cookie')!.split(';')[0]!;}
  const rCookie=await login(3),tCookie=await login(4);
  async function publish(){const id=crypto.randomUUID();await ok('plans',{id,goal:'R6 开放市场故障恢复验收任务',kind:'analysis',execution:'market',reward:'50000',fromBlock:'1',toBlock:'2'},rCookie);await ok('launch',{id:crypto.randomUUID(),goalId:id},rCookie);await coordinator.alarm();const g=JSON.parse(String(db.prepare('SELECT body FROM platform_goals WHERE id=?').get(id)!.body));assert(g.taskId);return g;}
  const task=async(id:string)=>client.readContract({address:manager,abi:taskManagerAbi,functionName:'getTask',args:[BigInt(id)]});
  const send=async(call:any)=>receipt(await wallets[4]!.sendTransaction({to:call.target,data:call.callData,value:0n}));
  const first=await publish();const runId=crypto.randomUUID();const p=await ok('taker/runs/prepare',{id:runId,taskId:first.taskId,mode:'sponsored'},tCookie);
  await ok('taker/runs/authorize',{id:runId,claimSignature:await taker!.signTypedData(p.claimTypedData),submitSignature:await taker!.signTypedData(p.submitTypedData)},tCookie);
  const sponsorKey=env.PLATFORM_SPONSOR_KEY!;delete env.PLATFORM_SPONSOR_KEY;
  await ok(`taker/runs/${runId}/claim`,{},tCookie);await coordinator.alarm();assert.equal((await task(first.taskId)).status,0);assert.equal(db.prepare('SELECT status FROM platform_commands WHERE id=?').get(`${runId}:claim`)!.status,'processing');
  // One unclaimed run is converted, not recreated, while sponsor is unavailable.
  await ok(`taker/runs/${runId}/resume`,{},tCookie);const walletClaim=await ok(`taker/runs/${runId}/claim`,{},tCookie);assert(walletClaim.walletRequired);await send(walletClaim.call);
  env.PLATFORM_SPONSOR_KEY=sponsorKey;db.exec("UPDATE platform_commands SET result=json_remove(result,'$.retryAt') WHERE status='processing'");await coordinator.alarm();assert.equal((await task(first.taskId)).attempt,1n);assert.equal(db.prepare('SELECT count(*) n FROM platform_runs WHERE task_id=?').get(first.taskId)!.n,1);
  const execution={output:{eventCount:'999',totalAmountBaseUnits:'0'},provenance:{toolVersion:'r6-fault/1',sourceChainId:'10143',blockRange:{fromBlock:'1',toBlock:'2',toBlockHash:(await client.getBlock({blockNumber:2n})).hash}}};
  await ok(`taker/runs/${runId}/result`,execution,tCookie);await send((await ok(`taker/runs/${runId}/submit`,{},tCookie)).call);
  for(let i=0;i<4;i++)await coordinator.alarm();assert.equal((await task(first.taskId)).status,0,'wrong deterministic result must reject and reopen');assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[taker!.address]}),0n);
  const old=await ok(`taker/runs/${runId}`,undefined,tCookie);assert(old.superseded);const activity=await ok('activity',undefined,tCookie);assert.equal(activity.items.find((x:any)=>x.targetId===runId).state,'superseded');
  // Requester service is deliberately not ticked during the second review window.
  const next=await ok('taker/runs/prepare',{id:crypto.randomUUID(),taskId:first.taskId,mode:'wallet'},tCookie);await send(next.claim);const good={...execution,output:{eventCount:'0',totalAmountBaseUnits:'0'}};await ok(`taker/runs/${next.id}/result`,good,tCookie);await send((await ok(`taker/runs/${next.id}/submit`,{},tCookie)).call);
  const reviewing=await task(first.taskId);assert.equal(reviewing.status,2);await raw('evm_setNextBlockTimestamp',[Number(reviewing.reviewDeadline)]);await raw('evm_mine',[]);
  coordinator=new PlatformCoordinator(ctx as any,env);for(let i=0;i<5;i++)await coordinator.alarm();assert.equal((await task(first.taskId)).status,3);assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[taker!.address]}),50000n,'timeout pays exactly once without quality acceptance');
  const timeout=await ok(`taker/runs/${next.id}`,undefined,tCookie);assert.equal(timeout.evidence,undefined);assert(timeout.events.some((e:any)=>e.event==='TaskSettled'&&String(e.args.reason)==='1'));
  const abandoned=await publish();const a=await ok('taker/runs/prepare',{id:crypto.randomUUID(),taskId:abandoned.taskId,mode:'wallet'},tCookie);await send(a.claim);const claim=await task(abandoned.taskId);await raw('evm_setNextBlockTimestamp',[Number(claim.claimLeaseExpiresAt)]);await raw('evm_mine',[]);for(let i=0;i<5;i++)await coordinator.alarm();assert.equal((await task(abandoned.taskId)).status,0);assert.equal((await call(`taker/runs/${a.id}/result`,good,tCookie)).status,400);
  await raw('evm_setNextBlockTimestamp',[Number(claim.taskDeadline)]);await raw('evm_mine',[]);for(let i=0;i<5;i++)await coordinator.alarm();assert.equal((await task(abandoned.taskId)).status,5);assert.equal(await client.readContract({address:manager,abi:taskManagerAbi,functionName:'totalEscrowed'}),0n);
  assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[vault]}),450000n,'one payment, unattended task refunded');
 }finally{globalThis.fetch=nativeFetch;db.close();anvil.kill('SIGTERM');}
});
