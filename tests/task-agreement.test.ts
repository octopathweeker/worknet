import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeTask, planSchema, transferAgreement } from '../apps/object-store/src/platform-domain.js';
import { briefInputSchema, prepareBrief } from '../apps/object-store/src/platform-brief.js';
import { taskReward, readTaskDraft, draftBasis } from '../apps/explorer/src/platform-draft.js';
import { validateTaskSpec } from '@agent-task/protocol';
import { hashJson } from '@agent-task/protocol/json';
import type { Env } from '../apps/object-store/src/index.js';

const agreement={deliverable:'说明 7702 的适用场景和限制，供团队评估钱包接入。',acceptanceCriteria:['说明授权流程。','列出资料中明确提及的限制。']};
const sourceUrls=['https://docs.monad.xyz/developer-essentials/eip-7702.md'];
const address=`0x${'11'.repeat(20)}` as const;
test('user agreement survives protocol construction and changes the committed hash',()=>{
 const input=planSchema.parse({id:crypto.randomUUID(),goal:'研究 7702 钱包授权，供团队评估接入。',kind:'research',execution:'market',reward:'12345',sourceUrls,agreement});
 const goal:any={id:input.id,owner:address,vault:address,input,status:'draft'};
 const config:any={manager:address,token:address};
 const spec=makeTask(goal,config,1900000000,1000n);validateTaskSpec(spec);
 assert(spec.instructions.includes(agreement.deliverable));assert.deepEqual(spec.verification.criteria.slice(1),agreement.acceptanceCriteria);assert.equal(spec.reward.amountBaseUnits,'12345');
 const changed=makeTask({...goal,input:{...input,agreement:{...agreement,acceptanceCriteria:['说明撤销授权的流程。']}}},config,1900000000,1000n);
 assert.notEqual(hashJson(spec),hashJson(changed));
 assert.equal(makeTask({...goal,input:{...input,agreement:undefined}},config,1900000000,1000n).verification.criteria.length,1,'legacy specs remain valid');
 assert.throws(()=>planSchema.parse({...input,agreement:{...agreement,acceptanceCriteria:[' ']}}));
 assert.throws(()=>planSchema.parse({...input,agreement:{...agreement,acceptanceCriteria:Array(9).fill('criterion')}}));
 assert.throws(()=>planSchema.parse({...input,kind:'analysis'}),'unverifiable custom transfer criteria must be rejected');
 assert(planSchema.safeParse({...input,kind:'analysis',agreement:transferAgreement}).success);
});

test('brief generation asks for missing inputs, rejects unsupported goals and fails closed on malformed model output',async()=>{
 let response:any={status:'ready',kind:'research',agreement};let calls=0;
 const env={PLATFORM_AI_MODEL:'fixture',AI:{run:async(_model:string,request:any)=>{calls++;const input=JSON.parse(request.messages[1].content);assert(!('reward' in input));assert(request.messages[0].content.includes('do not quietly rewrite or drop requirements'));return{response};}}} as unknown as Env;
 const input=briefInputSchema.parse({goal:'研究 7702 钱包授权，供团队评估接入。',sourceUrls});
 assert.deepEqual(await prepareBrief(input,env,address),response);
 assert.equal((await prepareBrief({...input,sourceUrls:[]},env,address)).status,'needs_input');
 response={status:'unsupported',reason:'无法执行买卖交易。'};assert.deepEqual(await prepareBrief({...input,goal:'请帮我买入一笔代币，并保证收益。'},env,address),response);
 response={status:'needs_input',reason:'需要确定范围。',questions:['请填写起止区块。']};assert.deepEqual(await prepareBrief(input,env,address),response);
 response={status:'ready',kind:'analysis',agreement};assert.deepEqual((await prepareBrief(input,env,address) as any).agreement,transferAgreement);
 assert.equal((await prepareBrief({...input,kind:'research',agreement},env,address)).status,'unsupported');
 response={status:'ready',kind:'research',agreement:{deliverable:'x',acceptanceCriteria:[]}};await assert.rejects(prepareBrief(input,env,address),/BRIEF_RESPONSE_INVALID/);
 response={status:'ready',kind:'research',agreement};const before=calls;await assert.rejects(prepareBrief({...input,sourceUrls:['https://docs.monad.xyz.evil.test/private']},env,address),/SOURCE_NOT_ALLOWED/);assert.equal(calls,before+1);
 await assert.rejects(prepareBrief({...input,fromBlock:'2000',toBlock:'1'},env,address),/INVALID_BLOCK_RANGE/);assert.equal(calls,before+1);
});

test('price validation never rounds excess precision and draft recovery preserves user criteria',()=>{
 assert.equal(taskReward('0.012345'),'12345');assert.equal(taskReward('0.20'),'200000');
 for(const value of ['0.009','0.200001','0.0500001','1e-2','NaN','-1'])assert.throws(()=>taskReward(value));
 const prior=Object.getOwnPropertyDescriptor(globalThis,'localStorage');let saved:any={goal:'我的 7702 钱包研究目标',kind:'research',sources:sourceUrls.join('\n'),reward:'0.012345',fromBlock:'',toBlock:'',agreement};saved.basis=draftBasis(saved);
 try{Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>JSON.stringify({...saved,flowVersion:2})}});assert.deepEqual(readTaskDraft(),saved);assert.notEqual(draftBasis({...saved,goal:'变更后的任务目标'}),saved.basis);saved={goal:'已有的旧版目标',kind:'analysis',reward:'0.05'};assert.equal(readTaskDraft().agreement,undefined);}
 finally{if(prior)Object.defineProperty(globalThis,'localStorage',prior);else Reflect.deleteProperty(globalThis,'localStorage');}
});

const generalAgreement={...agreement,deliverable:'东京五日行程与交通、预算估算。',acceptanceCriteria:['覆盖五天行程。'],intent:{version:'worknet-intent/1' as const,objective:'东京 5 日游攻略',constraints:['不进行预订。'],assumptions:['未指定日期。'],evidenceRequirements:['时效信息附来源。']}};
const quorum={judges:[address,`0x${'22'.repeat(20)}` as const,`0x${'33'.repeat(20)}` as const],threshold:2};
test('nonstandard intent is committed separately from presets and requires multiple Jev signatures',async()=>{
 const input=planSchema.parse({id:crypto.randomUUID(),goal:'帮我制定东京五日游攻略。',kind:'general',execution:'market',reward:'50000',sourceUrls:['https://www.gotokyo.org/en/'],agreement:generalAgreement});
 const goal:any={id:input.id,owner:address,vault:address,input,status:'draft'};
 const config:any={manager:address,token:address,quorum};
 const spec=makeTask(goal,config,1900000000,1000n);validateTaskSpec(spec);
 assert.equal(spec.capability,'task.general');assert.equal(spec.verification.profile,'jev.quorum');
 assert.equal((spec.input.intent as any).objective,'东京 5 日游攻略');assert.equal(spec.execution.claimLeaseSeconds,1800);
 assert(spec.verification.criteria.includes('约束：不进行预订。'));assert(spec.verification.criteria.includes('证据要求：时效信息附来源。'));
 assert.throws(()=>makeTask(goal,{...config,quorum:undefined},1900000000,1000n),/JUDGE_QUORUM_UNAVAILABLE/);
 assert.throws(()=>makeTask(goal,{...config,quorum:{...quorum,threshold:1}},1900000000,1000n),/JUDGE_QUORUM_UNAVAILABLE/);
 assert.throws(()=>planSchema.parse({...input,agreement:{deliverable:'x',acceptanceCriteria:['x']}}));
 const changed=makeTask({...goal,input:{...input,agreement:{...generalAgreement,intent:{...generalAgreement.intent,assumptions:['九月出行。']}}}},config,1900000000,1000n);assert.notEqual(hashJson(spec),hashJson(changed));
 let request:any;const env={PLATFORM_AI_MODEL:'fixture',AI:{run:async(_m:string,r:any)=>{request=r;return{response:{status:'ready',kind:'general',agreement:generalAgreement}};}}} as unknown as Env;
 const result=await prepareBrief(briefInputSchema.parse({goal:input.goal,kind:'general',sourceUrls:[]}),env,address);
 assert.equal(result.status,'ready');assert.equal((result as any).agreement.intent.objective,'东京 5 日游攻略');
 assert(request.messages[0].content.includes('MUST NOT limit'));assert(request.messages[0].content.includes('multiple Jev nodes'));
});

test('general evidence never presents supplied links as independently verified sources',async()=>{
 const { generalEvidence }=await import('../apps/judge-worker/src/index.js');
 const { generalOutput }=await import('../packages/judging/src/index.js');
 const { scoreCompletion }=await import('../packages/judging/src/index.js');
 const goal:any={id:crypto.randomUUID(),owner:address,vault:address,input:{goal:'帮我制定东京五日游攻略。',kind:'general',reward:'50000',agreement:generalAgreement}};
 const spec=makeTask(goal,{manager:address,token:address,quorum} as any,1900000000,1000n);
 const output={format:'markdown',content:'五日行程草稿',sources:[{title:'来源',url:'https://www.gotokyo.org/en/'}]};
 const payload:any={spec,result:{output}};let fetched=false;
 const before=globalThis.fetch;globalThis.fetch=async()=>{fetched=true;throw new Error('must not fetch');};
 try {const evidence=generalEvidence(payload);assert.equal(evidence.referencesIndependentlyVerified,false);assert.equal(fetched,false);
   let state:any;await scoreCompletion(payload,{apiKey:'fixture',judgeId:'judge-1',evidence,fetch:async(_u,init)=>{state=JSON.parse(String(init?.body)).state;return Response.json({answers:{completion:{type:'score',score:2.5}}});}});
   assert.equal(state.task.intent.objective,generalAgreement.intent.objective);assert.equal(state.evidence.referencesIndependentlyVerified,false);
 }finally{globalThis.fetch=before;}
 assert(!generalOutput.safeParse({...output,sources:[{title:'bad',url:'javascript:alert(1)'}]}).success);
 assert(!generalOutput.safeParse({...output,content:' '}).success);
});
