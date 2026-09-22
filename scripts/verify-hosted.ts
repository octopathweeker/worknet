import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {privateKeyToAccount} from 'viem/accounts';
import {erc20Abi,decodeEventLog} from 'viem';
import {taskManagerAbi} from '@agent-task/contracts';
import {client} from './testnet-common.js';
const config=JSON.parse(await readFile('.runtime/platform/config.json','utf8'));
const keys=JSON.parse(await readFile('.runtime/platform/accounts.private.json','utf8'));
const state=JSON.parse(await readFile('.runtime/platform/r5-verification.private.json','utf8'));
const results:Record<string,any>={};
async function login(role:string){const account=privateKeyToAccount(keys[role]);let cookie='';async function api(path:string,body?:unknown){let response:Response|undefined;for(let i=0;i<2;i++){try{response=await fetch(`${config.storageUrl}/platform/${path}`,{headers:{origin:config.storageUrl,cookie,'content-type':'application/json'},signal:AbortSignal.timeout(30000),redirect:'error',...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});break;}catch(e){if(i===1)throw e;}}const value=await response!.json()as any;if(!response!.ok)throw new Error(`${path}: ${JSON.stringify(value)}`);return{response:response!,value};}const c=(await api('auth/challenge',{address:account.address})).value;const login=await api('auth/verify',{id:c.id,signature:await account.signMessage({message:c.message})});cookie=login.response.headers.get('set-cookie')!.split(';')[0]!;return{account,api};}
await Promise.all(Object.entries(state.cases).map(async([persona,record])=>{
 const c=record as any;if(!c.currentRun)throw new Error('Complete browser preparation first');const {account,api}=await login(c.role);let previous='';let run:any;
 for(let i=0;i<120;i++){
  run=(await api(`taker/runs/${c.currentRun}`)).value;
  if(run.hosted?.status!==previous){console.log(JSON.stringify({persona,taskId:c.taskId,status:run.hosted?.status,chainStatus:run.task.status}));previous=run.hosted?.status;}
  if(['completed','settled_unverified','failed','stopped','expired','rejected'].includes(run.hosted?.status))break;
  await new Promise(r=>setTimeout(r,5000));
 }
 const {permissions:_permissions,...publicRun}=run;
 const after=await client.readContract({address:config.token,abi:erc20Abi,functionName:'balanceOf',args:[account.address]});
 results[persona]={taskId:c.taskId,runId:c.currentRun,address:account.address,balanceBefore:c.balanceBefore,balanceAfter:String(after),monBalance:String(await client.getBalance({address:account.address})),run:publicRun};
}));
const at=new Date().toISOString();await mkdir('docs/stages/R5',{recursive:true});await writeFile('docs/stages/R5/testnet-verification.json',JSON.stringify({at,origin:config.storageUrl,cases:results,scope:'Browser GUI against public APIs through a loopback test-only proxy and scoped software-wallet provider; no key in browser and no local task/model execution. Real wallet extensions remain Human validation.'},null,2)+'\n');
const intervals=[];
for(const result of Object.values(results)){
 assert.equal(result.run.hosted.status,'completed','Preserve rejected/failed original run; do not present it as success');assert.equal(result.run.task.status,3);assert.equal(result.run.task.worker.toLowerCase(),result.address.toLowerCase());assert.equal(result.run.evidence.verdict,'accept');assert.equal(result.run.evidence.resultHash,result.run.resultHash);assert.equal(BigInt(result.balanceAfter)-BigInt(result.balanceBefore),50000n);assert.equal(result.run.hosted.costs.serviceFeeBaseUnits,'0');
 const payment=result.run.events.find((e:any)=>e.event==='TaskSettled'||e.event==='accept');assert(payment);
 const receipt=await client.getTransactionReceipt({hash:payment.transactionHash});assert.equal(receipt.status,'success');const event=receipt.logs.filter(l=>l.address.toLowerCase()===config.manager.toLowerCase()).map(l=>decodeEventLog({abi:taskManagerAbi,data:l.data,topics:l.topics})).find(e=>e.eventName==='TaskSettled');assert(event&&event.eventName==='TaskSettled');assert.equal(Number(event.args.reason),0);assert.equal(event.args.amount,50000n);result.paymentHash=payment.transactionHash;
 const logs=result.run.hosted.logs;intervals.push([Date.parse(logs.find((l:any)=>l.stage==='running').at),Date.parse(logs.findLast((l:any)=>l.stage==='completed').at)]);
}
const overlap=Math.max(...intervals.map(i=>i[0]!))<Math.min(...intervals.map(i=>i[1]!));assert(overlap,'Independent hosted runs should overlap');
const escrow=await client.readContract({address:config.manager,abi:taskManagerAbi,functionName:'totalEscrowed'});
await writeFile('docs/stages/R5/testnet-verification.json',JSON.stringify({at,origin:config.storageUrl,cases:results,checks:{twoUsers:true,overlappingRuns:overlap,cloudExecution:true,acceptedPayments:true,noLocalAgentOrModel:true,serviceFeeBaseUnits:'0'},globalEscrowBaseUnits:String(escrow),scope:'GUI uses a scoped software-wallet fixture and separate test cookie jars; real extension and independent physical device remain Human validation. Global escrow may include unrelated user tasks; no unrelated task was modified.'},null,2)+'\n');
console.log('Both hosted browser runs completed and paid their user accounts; independent model review and receipt evidence saved.');
