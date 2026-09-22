import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { hashJson } from '@agent-task/protocol/json';
import { medianBps, splitReward, validateBinding, verifiedVerdicts, verdictTypedData, scoreCompletion, type JudgeRequest } from '../packages/judging/src/index.js';
import { makeTask } from '../apps/object-store/src/platform-domain.js';
import { internalModel } from '../apps/object-store/src/internal-model.js';
import { settlementMoney } from '../apps/explorer/src/settlement.js';

const manager='0x1111111111111111111111111111111111111111';
const judges=[1,2,3].map(n=>privateKeyToAccount(`0x${n.toString(16).padStart(64,'0')}`));
const config:any={chainId:10143,manager,token:manager,storageUrl:'https://store.test',quorum:{judges:judges.map(j=>j.address),threshold:2}};
function payload():JudgeRequest{
  const goal:any={id:'test',owner:manager,vault:manager,input:{goal:'Research task with clear criteria',kind:'research',reward:'50001'}};
  const spec=makeTask(goal,config,1000,10n);const specHash=hashJson(spec);
  const result:any={protocol:spec.protocol,settlementChainId:'10143',taskManager:manager,taskId:'1',attempt:'1',worker:manager,specHash,output:{summary:'Partial'},artifacts:[],provenance:{}};
  return {spec,result,taskId:'1',attempt:'1',specHash,resultHash:hashJson(result)};
}
test('quorum validates signatures and counts identities, rejects replay, and conserves rounding remainder',async()=>{
  const p=payload();validateBinding(p,10143,manager);
  const votes=await Promise.all(judges.map(async(j,i)=>({judge:j.address,completionBps:[10000,7500,5000][i]!,signature:await j.signTypedData(verdictTypedData(10143,manager,1n,1n,p.resultHash,[10000,7500,5000][i]!))})));
  await assert.rejects(verifiedVerdicts(p,config.quorum,[votes[0],votes[0]],10143,manager),/QUORUM_UNAVAILABLE/);
  const v=await verifiedVerdicts(p,config.quorum,[{...votes[0],completionBps:10},...votes],10143,manager);assert.equal(v.length,3);assert.equal(medianBps(v.map(v=>v.completionBps)),7500);
  assert.equal(medianBps([10000,5000]),5000);assert.deepEqual(splitReward(50001n,7500),{workerAmount:'37500',refundAmount:'12501'});
  await assert.rejects(verifiedVerdicts({...p,attempt:'2'},config.quorum,votes,10143,manager),/QUORUM_UNAVAILABLE/);
  await assert.rejects(verifiedVerdicts(p,config.quorum,votes,10144,manager),/QUORUM_UNAVAILABLE/);
  assert.throws(()=>validateBinding({...p,result:{...p.result,taskId:'2'}},10143,manager),/HASH_MISMATCH/);
  const result={...p.result,taskId:'2'};assert.throws(()=>validateBinding({...p,result,resultHash:hashJson(result)},10143,manager),/BINDING_MISMATCH/);
});
test('OpenRouter System One preserves fractional score and retries overload, rejects malformed scores',async()=>{
  let calls=0;let url='';let request:any;const mock:typeof fetch=async(input,init)=>{url=String(input);request=JSON.parse(String(init?.body));calls++;return new Response(JSON.stringify(calls===1?{}:{model:'typesafe/jev-1.13',answers:{completion:{type:'score',score:2.7}}}),{status:calls===1?529:200});};
  const score=await scoreCompletion(payload(),{apiKey:'test',judgeId:'judge-1',model:'jev-1.13',endpoint:'https://openrouter.ai/api/v1/systemone',fetch:mock,sleep:async()=>{}});
  assert.equal(calls,2);assert.equal(score.completionBps,6750);assert.equal(url,'https://openrouter.ai/api/v1/systemone');assert.equal(request.questions.completion.type,'score');assert.equal(request.questions.completion.criteria.length,5);
  await assert.rejects(scoreCompletion(payload(),{apiKey:'test',judgeId:'judge-1',fetch:async()=>new Response(JSON.stringify({answers:{completion:{type:'score',score:5}}}))}),/RESPONSE_INVALID/);
});
test('legacy profiles remain unchanged and model gateway rejects public unauthenticated access',async()=>{
  const goal:any={id:'x',owner:manager,vault:manager,input:{goal:'Research task',kind:'research',reward:'50000'}};
  assert.equal(makeTask(goal,{...config,quorum:undefined},1000,10n).verification.profile,'research-sources-and-judge');
  assert.equal(makeTask(goal,config,1000,10n).verification.profile,'jev.quorum');
  assert.equal(makeTask({...goal,input:{...goal.input,kind:'analysis'}},config,1000,10n).verification.profile,'rpc-transfer-aggregate');
  const r=await internalModel(new Request('https://model/internal/jev',{method:'POST',body:'{}'}),{MODEL_GATEWAY_TOKEN:'x'.repeat(32)});assert.equal(r.status,401);
});
test('partial USDC payouts and refunds retain base-unit precision in the UI',()=>{
  assert.equal(settlementMoney('7950'),'0.00795');
  assert.equal(settlementMoney('2050'),'0.00205');
  assert.equal(settlementMoney('1'),'0.000001');
  assert.equal(settlementMoney('0'),'0');
});
