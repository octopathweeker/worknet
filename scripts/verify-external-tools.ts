import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {erc20Abi,encodeFunctionData,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {requesterVaultAbi} from '@agent-task/contracts';
import {hashJson} from '@agent-task/protocol/json';
import {client,checkTestnet,TEST_USDC} from './testnet-common.js';
import {JournalWallet,privateJson,persistPrivate} from './platform-chain.js';

// Existing dedicated software test identities stand in for owner confirmations.
// This is not a product wallet-creation path or a claim of real Passkey device coverage.
const directory='.runtime/m6/protocol';
const c=JSON.parse(await readFile('.runtime/m6/config.json','utf8'));
const w=JSON.parse(await readFile('.runtime/m6/wrangler.jsonc','utf8'));
const origin=w.vars.WORKNET_PUBLIC_ORIGIN;
const s=await privateJson<any>('external-verification.json',()=>({goalId:randomUUID(),launchId:randomUUID(),runId:randomUUID()}),directory);
const save=()=>persistPrivate('external-verification.json',s,directory);
await checkTestnet();
const requesterKey=JSON.parse(await readFile('.runtime/m6/verification-accounts.private.json','utf8')).owner as Hex;
const takerKey=JSON.parse(await readFile('.runtime/m6/verification-market-accounts.private.json','utf8')).worker as Hex;
const takerWallet=new JournalWallet(takerKey,'verification-taker','.runtime/m6');
async function login(key:Hex){
 const account=privateKeyToAccount(key);let cookie='';
 const raw=(path:string,body?:unknown)=>fetch(`${origin}/platform/${path}`,{headers:{origin,cookie,'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(30000),...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
 const call=async(path:string,body?:unknown)=>{const r=await raw(path,body);const data=await r.json() as any;assert(r.ok,`${path}: ${data.error}`);return data;};
 const challenge=await call('auth/challenge',{address:account.address});const r=await raw('auth/verify',{id:challenge.id,signature:await account.signMessage({message:challenge.message})});assert(r.ok);cookie=r.headers.get('set-cookie')!.split(';')[0]!;return{account,call};
}
const requester=await login(requesterKey),taker=await login(takerKey);
const account=await requester.call('account');
if(s.result){console.log(JSON.stringify({alreadyVerified:true,taskId:s.result.taskId,payment:s.result.payment}));process.exit(0);}
const beforeGoal=(await requester.call('goals')).goals.find((g:any)=>g.id===s.goalId);
assert(BigInt(account.budget.vaultBalance)>=10000n);
if(!beforeGoal?.taskId&&(!account.budget.effectiveActive||BigInt(account.budget.newCommitmentCapacity)<10000n||BigInt(account.budget.validUntil)<(await client.getBlock()).timestamp+4200n)){
 s.validUntil??=((await client.getBlock()).timestamp+86400n).toString();await save();
 assert.equal((await new JournalWallet(requesterKey,'verification-owner','.runtime/m6').send('external-tools-authorize-v1',{to:account.vault,data:encodeFunctionData({abi:requesterVaultAbi,functionName:'authorizeAgent',args:[c.operator,{validAfter:0n,validUntil:BigInt(s.validUntil),maxPerTask:10000n,maxTotalCommitment:10000n}]})})).status,'success');
}
const cliPath=resolve('apps/explorer/dist/downloads/worknet-taker.mjs');
const credentialFile=resolve(directory,'external-cli.private.json');
const environment={...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string')),WORKNET_TAKER_CONFIG:credentialFile};
async function cli(args:string[]){return new Promise<any>((done,fail)=>{
 const child=spawn(process.execPath,[cliPath,...args],{env:environment,stdio:['ignore','pipe','pipe']});let out='',err='';
 child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk);const timer=setTimeout(()=>child.kill('SIGTERM'),90000);
 child.on('error',fail);child.on('close',code=>{clearTimeout(timer);if(code!==0){fail(new Error(`CLI ${args[0]} failed: ${err.slice(-800)}`));return;}try{done(JSON.parse(out));}catch{fail(new Error('CLI returned invalid JSON'));}});
});}
const pair=await cli(['pair',origin,'External MPP acceptance']);s.executorId=pair.id;await save();await taker.call('taker/pair/approve',{id:pair.id});
const payer=privateKeyToAccount(JSON.parse(await readFile(`${directory}/accounts.private.json`,'utf8')).payer).address;
if(!s.before){s.before={payerNonce:await client.getTransactionCount({address:payer}),payerUSDC:String(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[payer]})),takerUSDC:String(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[taker.account.address]})),vaultUSDC:String(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[account.vault]}))};await save();}
if(!beforeGoal?.taskId){
 s.block??=(await client.getBlock({blockTag:'finalized'})).number.toString();await save();
 await requester.call('plans',{id:s.goalId,goal:'外部 Agent 的真实 MPP 接单验收：通过配对执行器采购固定区块的转账统计，独立审核并将完整奖励支付给接单账户。',kind:'analysis',execution:'market',reward:'10000',fromBlock:s.block,toBlock:s.block});
 await requester.call('launch',{id:s.launchId,goalId:s.goalId});
}
for(let n=0;!s.taskId;n++){
 const command=await requester.call(`commands/${s.launchId}`);if(command.status==='failed')throw new Error('Publication failed; inspect before retry');
 if(command.status==='complete'){s.taskId=command.result.taskId;await save();break;}
 assert(n<90,'Publication pending; rerun to resume');await new Promise(r=>setTimeout(r,2000));
}
await taker.call('taker/runs/prepare',{id:s.runId,taskId:s.taskId,executorId:pair.id,mode:'wallet'});
let run=await taker.call(`taker/runs/${s.runId}`);
if(Number(run.task.status)===0){const claim=await cli(['claim',s.runId]);assert(claim.walletRequired);assert.equal(claim.call.target.toLowerCase(),c.manager.toLowerCase());assert.equal((await takerWallet.send('external-tools-claim-v1',{to:claim.call.target,data:claim.call.callData,value:0n})).status,'success');}
run=await taker.call(`taker/runs/${s.runId}`);
if(Number(run.task.status)===1){
 if(!run.resultHash){
  const mcp=new Client({name:'worknet-external-mpp-verification',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[cliPath,'mcp'],env:environment,stderr:'pipe'});
  try{
   await mcp.connect(transport);const definition=(await mcp.listTools()).tools.find(t=>t.name==='taker_purchase_transfers')!;assert.equal(definition.annotations?.readOnlyHint,false);
   const result=await mcp.callTool({name:'taker_purchase_transfers',arguments:{runId:s.runId}});assert(!result.isError,JSON.stringify(result.content));
   s.execution=JSON.parse((result.content as any)[0].text);s.executionHash=hashJson(s.execution);await save();
   const repeated=await cli(['tool',s.runId]);assert.equal(hashJson(repeated),s.executionHash);
  }finally{await mcp.close();}
 }
 const result=await cli(['run',s.runId,'--paid-tool']);assert(result.walletRequired);assert.equal(result.call.target.toLowerCase(),c.manager.toLowerCase());
 assert.equal((await takerWallet.send('external-tools-submit-v1',{to:result.call.target,data:result.call.callData,value:0n})).status,'success');
}
for(let n=0;n<90;n++){
 run=await taker.call(`taker/runs/${s.runId}`);
 if(Number(run.task.status)===3&&run.evidence){
  assert.equal(run.evidence.verdict,'accept');assert.equal(run.task.worker.toLowerCase(),taker.account.address.toLowerCase());assert.equal(run.result.agentRef,undefined);
  assert.equal(run.toolPayments.length,1);const payment=run.toolPayments[0];assert.equal(payment.status,'delivered');assert.equal(payment.amountBaseUnits,'1000');
  assert.equal(run.result.artifacts.filter((a:any)=>a.mediaType==='application/vnd.worknet.tool-purchase+json').length,1);
  assert.equal(await client.getTransactionCount({address:payer}),s.before.payerNonce+1);
  assert.equal(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[payer]}),BigInt(s.before.payerUSDC)-1000n);
  assert.equal(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[taker.account.address]}),BigInt(s.before.takerUSDC)+10000n);
  assert.equal(await client.readContract({address:TEST_USDC,abi:erc20Abi,functionName:'balanceOf',args:[account.vault]}),BigInt(s.before.vaultUSDC)-10000n);
  await taker.call('taker/executors/revoke',{id:pair.id});
  s.result={verifiedAt:new Date().toISOString(),taskId:s.taskId,runId:s.runId,owner:taker.account.address,payment:payment.transactionHash,toolFee:'1000',reward:'10000',resultHash:run.resultHash,artifacts:run.result.artifacts,events:run.events,executorRevoked:true};await save();console.log(JSON.stringify(s.result));process.exit(0);
 }
 if(n%5===0)console.log(JSON.stringify({taskId:s.taskId,status:run.task.status,evidence:run.evidence?.verdict}));
 assert(Number(run.task.status)<4,'Task ended without acceptance');await new Promise(r=>setTimeout(r,3000));
}
throw new Error('External verification pending; resume the same intent');
