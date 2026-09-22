import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {erc20Abi,encodeFunctionData,parseEther,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {delegatedImplementation,disablePermission} from '@agent-task/accounts';
import {requesterVaultAbi} from '@agent-task/contracts';
import {client,checkTestnet,TEST_USDC} from './testnet-common.js';
import {JournalWallet,privateJson,persistPrivate} from './platform-chain.js';

// Dedicated software acceptance identities simulate only the initial owner signatures.
// No virtual Passkey is created, and this is not real authenticator/device coverage.
const directory='.runtime/m6/protocol';
const state=await privateJson<any>('agent-account-verification.json',()=>({goalId:randomUUID(),launchId:randomUUID()}),directory);
const save=()=>persistPrivate('agent-account-verification.json',state,directory);
if(state.result){console.log(JSON.stringify({alreadyVerified:true,...state.result}));process.exit(0);}
await checkTestnet();
const config=JSON.parse(await readFile('.runtime/m6/config.json','utf8'));
const origin=JSON.parse(await readFile('.runtime/m6/wrangler.jsonc','utf8')).vars.WORKNET_PUBLIC_ORIGIN;
const requesterKey=JSON.parse(await readFile('.runtime/m6/verification-accounts.private.json','utf8')).owner as Hex;
const rootKey=JSON.parse(await readFile('.runtime/m6/verification-market-accounts.private.json','utf8')).worker as Hex;
const rootWallet=new JournalWallet(rootKey,'verification-taker','.runtime/m6');
async function login(key:Hex){const account=privateKeyToAccount(key);let cookie='';
 const raw=(path:string,body?:unknown)=>fetch(`${origin}/platform/${path}`,{headers:{origin,cookie,'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(30000),...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
 const call=async(path:string,body?:unknown)=>{const r=await raw(path,body);const data=await r.json() as any;assert(r.ok,`${path}: ${data.error} ${data.code??''}`);return data;};
 const c=await call('auth/challenge',{address:account.address});const r=await raw('auth/verify',{id:c.id,signature:await account.signMessage({message:c.message})});assert(r.ok);cookie=r.headers.get('set-cookie')!.split(';')[0]!;return {account,call};}
const requester=await login(requesterKey),root=await login(rootKey);
const cliPath=resolve('apps/explorer/dist/downloads/worknet-taker.mjs'),file=resolve(directory,'agent-cli.private.json');
async function cli(args:string[]){return new Promise<any>((done,fail)=>{const child=spawn(process.execPath,[cliPath,...args],{env:{...process.env,WORKNET_TAKER_CONFIG:file},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const timer=setTimeout(()=>child.kill('SIGTERM'),120000);child.on('error',fail);child.on('close',code=>{clearTimeout(timer);if(code!==0){fail(new Error(`CLI ${args[0]}: ${err.slice(-1400)}`));return;}try{done(JSON.parse(out));}catch{fail(new Error('Invalid CLI output'));}});});}
const initial=await cli(['init',origin,'Autonomous account acceptance']);state.executorId=initial.id;state.signer=initial.signer;await save();
if(!state.approved){
 // Fund from the existing dedicated test owner before signing its activation nonce.
 assert.equal((await rootWallet.send('agent-session-gas-v1',{to:initial.signer,value:parseEther('0.08')})).status,'success');
 const prepared=await root.call('taker/agent/prepare',{id:initial.id});
 let authorization;
 if(prepared.activationRequired){const a=await root.account.signAuthorization({chainId:10143,contractAddress:delegatedImplementation,nonce:prepared.nonce});authorization={address:a.address,chainId:a.chainId,nonce:a.nonce,r:a.r,s:a.s,yParity:a.yParity};}
 const approved=await root.call('taker/agent/approve',{id:initial.id,signature:await root.account.signTypedData(prepared.typedData),...(authorization?{authorization}:{})});
 state.grant=approved.grant;state.approved=true;state.initialActivationRequired=prepared.activationRequired;await save();
}
if(!state.gasTopped){assert.equal((await new JournalWallet(requesterKey,'verification-owner','.runtime/m6').send('agent-session-extra-test-gas-v1',{to:initial.signer,value:parseEther('0.08')})).status,'success');state.gasTopped=true;await save();}
const status=await cli(['status']);assert.equal(status.rewardAddress,root.account.address.toLowerCase());
const account=state.taskId?null:await requester.call('account');const prior=state.taskId?{taskId:state.taskId}:(await requester.call('goals')).goals.find((g:any)=>g.id===state.goalId);
if(!state.before){state.before={reward:String(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[root.account.address]})),signerNonce:await client.getTransactionCount({address:initial.signer})};await save();}
if(!prior?.taskId){
 assert(BigInt(account.budget.vaultBalance)>=10000n);
 state.validUntil??=((await client.getBlock()).timestamp+86400n).toString();await save();
 if(!account.budget.effectiveActive||BigInt(account.budget.newCommitmentCapacity)<10000n||BigInt(account.budget.validUntil)<(await client.getBlock()).timestamp+4200n){
  assert.equal((await new JournalWallet(requesterKey,'verification-owner','.runtime/m6').send('agent-session-requester-authorize-v1',{to:account.vault,data:encodeFunctionData({abi:requesterVaultAbi,functionName:'authorizeAgent',args:[config.operator,{validAfter:0n,validUntil:BigInt(state.validUntil),maxPerTask:10000n,maxTotalCommitment:10000n}]})})).status,'success');
 }
 state.block??=(await client.getBlock({blockTag:'finalized'})).number.toString();await save();
 await requester.call('plans',{id:state.goalId,goal:'自主 Agent 账户验收：仅首次账户授权后，由本地执行密钥自主领取、分析固定区块转账、提交，并核对奖励进入独立收款账户。',kind:'analysis',execution:'market',reward:'10000',fromBlock:state.block,toBlock:state.block});
 await requester.call('launch',{id:state.launchId,goalId:state.goalId});
}
for(let n=0;!state.taskId;n++){const command=await requester.call(`commands/${state.launchId}`);if(command.status==='failed')throw new Error('Publication failed; inspect the original intent');if(command.status==='complete'){state.taskId=command.result.taskId;await save();break;}assert(n<90,'Publication pending; resume this script');await new Promise(r=>setTimeout(r,2000));}
if(!state.runId){const taken=await cli(['take',state.taskId]);state.runId=taken.id;await save();assert.equal((await cli(['take',state.taskId])).id,state.runId);}
let run=await cli(['get',state.runId]);
if(Number(run.task.status)<2){const submitted=await cli(['run',state.runId]);assert(!submitted.walletRequired);state.submitted=submitted;await save();console.log(JSON.stringify({taskId:state.taskId,runId:state.runId,submitted}));}
await cli(['run',state.runId]);
for(let n=0;n<90;n++){
 run=await root.call(`taker/runs/${state.runId}`);
 if(Number(run.task.status)===3&&run.evidence){
  assert.equal(run.evidence.verdict,'accept');assert.equal(run.task.worker.toLowerCase(),root.account.address.toLowerCase());
  assert.equal(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[root.account.address]}),BigInt(state.before.reward)+10000n);
  assert.equal(await client.getTransactionCount({address:initial.signer}),state.before.signerNonce+2,'one claim and one submission despite repeated run');
  assert.equal((await cli(['status'])).remainingCalls,198);
  const revoke=disablePermission(state.grant.permission);assert.equal((await rootWallet.send('agent-session-revoke-v1',{to:revoke.to,data:revoke.data})).status,'success');
  assert.equal((await cli(['status'])).chainRevoked,true);
  await root.call('taker/executors/revoke',{id:initial.id});
  state.result={verifiedAt:new Date().toISOString(),taskId:state.taskId,runId:state.runId,root:root.account.address,gasAddress:initial.signer,reward:'10000',resultHash:run.resultHash,events:run.events,firstActivation:state.initialActivationRequired,executionTransactions:2,chainRevoked:true,apiRevoked:true,realPasskeyDeviceTest:false};await save();console.log(JSON.stringify(state.result));process.exit(0);
 }
 assert(Number(run.task.status)<4,'Task ended without acceptance');if(n%5===0)console.log(JSON.stringify({taskId:state.taskId,status:run.task.status,verdict:run.evidence?.verdict}));await new Promise(r=>setTimeout(r,3000));
}
throw new Error('Verification pending; resume same journal');
