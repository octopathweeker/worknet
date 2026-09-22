import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { canonicalJson, hashJson } from '@agent-task/protocol/json';
import { encodeFunctionData, decodeEventLog, erc20Abi, parseEther, type Hex, type Address } from 'viem';
import { requesterVaultAbi, taskManagerAbi } from '@agent-task/contracts';
import { factoryAbi } from '@agent-task/accounts';
import { client, TEST_USDC } from './testnet-common.js';
import { JournalWallet, privateJson, persistPrivate } from './platform-chain.js';

const market=process.argv.includes('--market');const label=market?'market':'owner';
const directory='.runtime/m6';const config=JSON.parse(await readFile(`${directory}/config.json`,'utf8'));
const state=await privateJson<any>(market?'verification-market.json':'verification.json',()=>({id:randomUUID(),goalId:randomUUID(),commandId:randomUUID()}),directory);
const keys=await privateJson<{owner:Hex;worker?:Hex}>(market?'verification-market-accounts.private.json':'verification-accounts.private.json',()=>({owner:generatePrivateKey(),...(market?{worker:generatePrivateKey()}:{})}),directory);
const owner=new JournalWallet(keys.owner,`verification-${label}`,directory);
const roleKey=async(role:string,variable:string)=>{const s=await readFile(`.runtime/testnet-accounts/${role}.env`,'utf8');const v=new RegExp(`^${variable}=(.+)$`,'m').exec(s)?.[1]?.trim().replace(/^['"]|['"]$/g,'');if(!v)throw new Error(`MISSING_${variable}`);return v as Hex;};
const funder=new JournalWallet(await roleKey('deployer','DEPLOYER_PRIVATE_KEY'),'m6-deployer',directory);
const usdcFunder=new JournalWallet(await roleKey('owner','AGENT_PRIVATE_KEY'),'verification-funding-owner',directory);
const save=()=>persistPrivate(market?'verification-market.json':'verification.json',state,directory);
for(const [wallet,id,call] of [
  [funder,`verification-${label}-gas`,{to:owner.account.address,value:parseEther('0.5')}],
  [usdcFunder,`verification-${label}-usdc`,{to:TEST_USDC,data:encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[owner.account.address,50000n]})}],
] as const){assert.equal((await wallet.send(id,call)).status,'success');}
const external=market?new JournalWallet(keys.worker!,'verification-taker',directory):undefined;
if(external)assert.equal((await funder.send('verification-taker-gas',{to:external.account.address,value:parseEther('0.2')})).status,'success');
let cookie='';
async function api(route:string,body?:unknown){const r=await fetch(`${config.storageUrl}/platform/${route}`,{method:body===undefined?'GET':'POST',headers:{origin:config.storageUrl,'content-type':'application/json',cookie},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(25000)});const value=await r.json() as any;if(!r.ok)throw new Error(`API_${r.status}:${value.error}`);return {value,response:r};}
const challenge=(await api('auth/challenge',{address:owner.account.address})).value;
const login=await api('auth/verify',{id:challenge.id,signature:await owner.account.signMessage({message:challenge.message})});cookie=login.response.headers.get('set-cookie')!.split(';')[0]!;
assert.equal((await owner.send('create-vault',{to:config.factory,data:encodeFunctionData({abi:factoryAbi,functionName:'createVault',args:[owner.account.address]})})).status,'success');
const vault=await client.readContract({address:config.factory,abi:factoryAbi,functionName:'vaultOf',args:[owner.account.address]});
assert.equal((await owner.send('approve-budget',{to:TEST_USDC,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[vault,50000n]})})).status,'success');
assert.equal((await owner.send('deposit-budget',{to:vault,data:encodeFunctionData({abi:requesterVaultAbi,functionName:'deposit',args:[50000n]})})).status,'success');
state.validUntil??=((await client.getBlock()).timestamp+86400n).toString();await save();
assert.equal((await owner.send('authorize-budget',{to:vault,data:encodeFunctionData({abi:requesterVaultAbi,functionName:'authorizeAgent',args:[config.operator,{validAfter:0n,validUntil:BigInt(state.validUntil),maxPerTask:50000n,maxTotalCommitment:50000n}]})})).status,'success');
await api('plans',{id:state.goalId,execution:market?'market':'platform',kind:'research',goal:'根据指定官方文档，说明 EIP-7702 对钱包账户带来的一个变化。只写一个有精确引文支持的事实和简短总结，不推断文档未说明的能力。',reward:'10000',sourceUrls:['https://docs.monad.xyz/developer-essentials/eip-7702.md']});
await api('launch',{id:state.commandId,goalId:state.goalId});
const until=Date.now()+12*60000;let last='';
while(Date.now()<until){
  const goals=(await api('goals')).value.goals as any[];const goal=goals.find(g=>g.id===state.goalId);const summary=JSON.stringify({status:goal?.status,taskId:goal?.taskId,onchain:goal?.task?.status,error:goal?.error,completionBps:goal?.settlement?.completionBps});
  if(last!==summary){console.log(summary);last=summary;}
  if(external&&goal?.taskId&&Number(goal.task?.status)<2){
    const id=BigInt(goal.taskId);let task=await client.readContract({address:config.manager,abi:taskManagerAbi,functionName:'getTask',args:[id]});
    if(task.status===0)assert.equal((await external.send(`claim-${id}-${task.attempt+1n}`,{to:config.manager,data:encodeFunctionData({abi:taskManagerAbi,functionName:'claimTask',args:[id]})})).status,'success');
    task=await client.readContract({address:config.manager,abi:taskManagerAbi,functionName:'getTask',args:[id]});
    if(task.status===1){
      const result={protocol:'agent-task/0.1',settlementChainId:'10143',taskManager:config.manager.toLowerCase(),taskId:id.toString(),attempt:task.attempt.toString(),worker:external.account.address.toLowerCase(),specHash:task.specHash,output:{mode:'llm',summary:'文档讨论 EIP-7702 钱包授权，但这份交付尚未整理具体变化或提供支持引文。',findings:[]},artifacts:[],provenance:{toolVersion:'m6-public-partial-verification/1'}};
      const hash=hashJson(result);const secrets=JSON.parse(await readFile(`${directory}/platform-secrets.json`,'utf8'));
      const uploaded=await fetch(`${config.storageUrl}/objects/${hash}`,{method:'PUT',headers:{authorization:`Bearer ${secrets.STORAGE_UPLOAD_TOKEN}`},body:canonicalJson(result)});assert(uploaded.ok);
      assert.equal((await external.send(`submit-${id}-${task.attempt}`,{to:config.manager,data:encodeFunctionData({abi:taskManagerAbi,functionName:'submitResult',args:[id,task.attempt,hash,`${config.storageUrl}/objects/${hash}`]})})).status,'success');
    }
  }
  if(goal?.settlement){
    const task=await client.readContract({address:config.manager,abi:taskManagerAbi,functionName:'getTask',args:[BigInt(goal.taskId)]});
    assert.equal(task.status,3);const s=goal.settlement;assert.equal(BigInt(s.workerAmount)+BigInt(s.refundAmount),10000n);assert.equal(BigInt(s.workerAmount),10000n*BigInt(s.completionBps)/10000n);
    const receipt=await client.getTransactionReceipt({hash:s.transactionHash as Hex});assert.equal(receipt.status,'success');
    const transfers=receipt.logs.filter(l=>l.address.toLowerCase()===TEST_USDC.toLowerCase()).flatMap(l=>{try{const e=decodeEventLog({abi:erc20Abi,data:l.data,topics:l.topics});return e.eventName==='Transfer'?[e.args]:[];}catch{return [];}});
    if(BigInt(s.workerAmount)>0n)assert(transfers.some(t=>t.from.toLowerCase()===config.manager.toLowerCase()&&t.to.toLowerCase()===task.worker.toLowerCase()&&t.value===BigInt(s.workerAmount)));
    if(BigInt(s.refundAmount)>0n)assert(transfers.some(t=>t.from.toLowerCase()===config.manager.toLowerCase()&&t.to.toLowerCase()===vault.toLowerCase()&&t.value===BigInt(s.refundAmount)));
    if(market)assert(s.completionBps<10000,'intentionally incomplete delivery must not receive full reward');
    assert.equal(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[vault]}),50000n-BigInt(s.workerAmount));
    state.result={verifiedAt:new Date().toISOString(),taskId:goal.taskId,manager:config.manager,vault,owner:owner.account.address,settlement:s,judges:goal.evidence.verdicts.map((v:any)=>({judge:v.judge,completionBps:v.completionBps,model:v.model})),transactionHash:receipt.transactionHash};await save();console.log('M6_PUBLIC_SETTLEMENT_VERIFIED');process.exit(0);
  }
  if(goal?.task?.status>=3)throw new Error('ENDED_WITHOUT_JUDGE_SETTLEMENT');
  await new Promise(r=>setTimeout(r,6000));
}
throw new Error('PUBLIC_VERIFICATION_TIMEOUT: rerun to resume the existing intent');
