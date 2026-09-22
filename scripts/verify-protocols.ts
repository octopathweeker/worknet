import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { erc20Abi, encodeFunctionData, parseEventLogs, type Hex } from 'viem';
import { requesterVaultAbi, taskManagerAbi } from '@agent-task/contracts';
import { hashJson } from '@agent-task/protocol/json';
import { verifyWorkerBinding } from '@agent-task/identity';
import { client, checkTestnet, TEST_USDC } from './testnet-common.js';
import { JournalWallet, privateJson, persistPrivate } from './platform-chain.js';
import { recomputeTransfers } from '../apps/object-store/src/platform-execution.js';

const directory='.runtime/m6/protocol';
const config=JSON.parse(await readFile('.runtime/m6/config.json','utf8'));
const platform=JSON.parse(await readFile('.runtime/m6/wrangler.jsonc','utf8'));
const activation=JSON.parse(await readFile(`${directory}/activation.json`,'utf8'));
const protocol=JSON.parse(await readFile('.runtime/m6/protocol-secrets.json','utf8'));
const policy=JSON.parse(protocol.MPP_TOOL_CONFIG);
const owner=new JournalWallet(JSON.parse(await readFile('.runtime/m6/verification-accounts.private.json','utf8')).owner,'verification-owner','.runtime/m6');
const state=await privateJson<any>('verification.json',()=>({goalId:randomUUID(),commandId:randomUUID()}),directory);
const save=()=>persistPrivate('verification.json',state,directory);
await checkTestnet();
let cookie='';const origin=platform.vars.WORKNET_PUBLIC_ORIGIN as string;
async function api(route:string,body?:unknown){
  const response=await fetch(`${origin}/platform/${route}`,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',cookie},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const value=await response.json() as any;if(!response.ok)throw new Error(`API_${response.status}:${value.error}`);return{value,response};
}
const challenge=(await api('auth/challenge',{address:owner.account.address})).value;
const login=await api('auth/verify',{id:challenge.id,signature:await owner.account.signMessage({message:challenge.message})});
cookie=login.response.headers.get('set-cookie')!.split(';')[0]!;
const account=(await api('account')).value;
assert(account.budget && BigInt(account.budget.vaultBalance)>=10000n,'Dedicated verification account needs existing task budget');
const beforeGoal=(await api('goals')).value.goals.find((g:any)=>g.id===state.goalId);
if(!beforeGoal?.taskId && (!account.budget.effectiveActive || BigInt(account.budget.validUntil)<(await client.getBlock()).timestamp+4200n || BigInt(account.budget.newCommitmentCapacity)<10000n)) {
  state.validUntil??=((await client.getBlock()).timestamp+86400n).toString();await save();
  assert.equal((await owner.send('protocol-verification-authorize-v1',{to:account.vault,data:encodeFunctionData({abi:requesterVaultAbi,functionName:'authorizeAgent',args:[config.operator,{validAfter:0n,validUntil:BigInt(state.validUntil),maxPerTask:10000n,maxTotalCommitment:10000n}]})})).status,'success');
}
const fundingJournal=JSON.parse(await readFile('.runtime/m6/journal-verification-funding-owner.json','utf8'));
const funding=await client.getTransactionReceipt({hash:fundingJournal['protocol-payer-usdc-v1'].hash});
state.block??=funding.blockNumber.toString();
const keys=JSON.parse(await readFile(`${directory}/accounts.private.json`,'utf8'));
const {privateKeyToAccount}=await import('viem/accounts');const payer=privateKeyToAccount(keys.payer).address;
const recipient=activation.provider.snapshot.agentWallet;
if(!state.before){
  state.before={payerNonce:await client.getTransactionCount({address:payer}),payerUSDC:String(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[payer]})),providerUSDC:String(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[recipient]})),workerUSDC:String(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[config.worker]})),vaultUSDC:String(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[account.vault]}))};await save();
}
if(!beforeGoal?.taskId){
  if(beforeGoal?.publication?.status==='failed' && beforeGoal.publication.id===state.commandId){
    state.failedCommands??=[];assert(state.failedCommands.length<2,'Inspect failed publication before further retries');
    state.failedCommands.push(state.commandId);state.commandId=randomUUID();await save();
  }
  await api('plans',{id:state.goalId,execution:'platform',kind:'analysis',goal:'验证 ERC-8004 实际身份与 MPP 工具采购：统计指定已最终确认区块的 USDC Transfer 次数及原始金额，由平台独立复算。',reward:'10000',fromBlock:state.block,toBlock:state.block});
  await api('launch',{id:state.commandId,goalId:state.goalId});
}
const deadline=Date.now()+8*60000;let last='';
while(Date.now()<deadline){
  const g=(await api('goals')).value.goals.find((g:any)=>g.id===state.goalId);
  const summary=JSON.stringify({taskId:g?.taskId,status:g?.status,chainStatus:g?.task?.status,error:g?.error,payments:g?.toolPayments?.map((p:any)=>({status:p.status,amount:p.amountBaseUnits,hash:p.transactionHash}))});
  if(last!==summary){console.log(summary);last=summary;}
  if(g?.publication?.status==='failed')throw new Error('PUBLICATION_FAILED: inspect before resuming the same goal');
  if(g?.task?.status===3 && g.result && g.evidence){
    assert.equal(g.evidence.verdict,'accept','Actual independent verification must pass');
    assert.equal(g.result.agentRef.agentId,activation.executor.agentId);
    const identity=await verifyWorkerBinding(client,g.result.agentRef,config.worker,[activation.registry]);
    const expected=await recomputeTransfers(g.spec.input,config);assert.deepEqual(g.result.output,expected.output);
    const payments=g.toolPayments;assert.equal(payments.length,1);assert.equal(payments[0].status,'delivered');assert.equal(payments[0].amountBaseUnits,'1000');
    const paymentHash=payments[0].transactionHash as Hex;
    const paid=await client.getTransactionReceipt({hash:paymentHash});assert.equal(paid.status,'success');
    const transfers=parseEventLogs({abi:erc20Abi,eventName:'Transfer',logs:paid.logs});
    assert(transfers.some(l=>l.address.toLowerCase()===TEST_USDC.toLowerCase() && l.args.from.toLowerCase()===payer.toLowerCase() && l.args.to.toLowerCase()===recipient.toLowerCase() && l.args.value===1000n));
    assert.equal(await client.getTransactionCount({address:payer}),state.before.payerNonce+1,'One payment transaction');
    assert.equal(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[payer]}),BigInt(state.before.payerUSDC)-1000n);
    assert.equal(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[recipient]}),BigInt(state.before.providerUSDC)+1000n);
    assert.equal(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[config.worker]}),BigInt(state.before.workerUSDC)+10000n,'Reward not reduced by the tool fee');
    assert.equal(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[account.vault]}),BigInt(state.before.vaultUSDC)-10000n,'User budget pays only the reward');
    const artifacts=[];
    for(const a of g.result.artifacts){const response=await fetch(a.uri);assert(response.ok);const value=await response.json();assert.equal(hashJson(value),a.hash);artifacts.push({uri:a.uri,hash:a.hash,mediaType:a.mediaType,value});}
    const purchase=artifacts.find(a=>a.mediaType==='application/vnd.worknet.tool-purchase+json');assert(purchase);assert.equal(purchase.value.provider.ref.agentId,activation.provider.agentId);
    const task=await client.readContract({address:config.manager,abi:taskManagerAbi,functionName:'getTask',args:[BigInt(g.taskId)],blockTag:'finalized'});assert.equal(task.status,3);assert.equal(task.resultHash,hashJson(g.result));
    state.result={verifiedAt:new Date().toISOString(),taskId:g.taskId,goalId:g.id,owner:owner.account.address,manager:config.manager,vault:account.vault,payer,recipient,identity,output:g.result.output,artifacts,paymentTransaction:paymentHash,toolFee:'1000',taskReward:'10000',payerNonce:state.before.payerNonce+1,events:g.events};await save();
    console.log('PUBLIC_IDENTITY_MPP_AND_REWARD_VERIFIED');process.exit(0);
  }
  if(g?.task?.status>=3)throw new Error('TASK_ENDED_WITHOUT_VERIFIED_DELIVERY');
  await new Promise(resolve=>setTimeout(resolve,6000));
}
throw new Error('PROTOCOL_VERIFICATION_TIMEOUT: resume this same intent');
