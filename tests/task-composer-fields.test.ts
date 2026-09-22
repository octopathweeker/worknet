import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asGeneralDraft, draftParameters, emptyTaskDraft, presetDraft, readTaskDraft, taskExamples } from '../apps/explorer/src/platform-draft.js';

test('a fresh homepage is blank and general even when an older preset draft is saved',()=>{
 const prior=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 const saved={...presetDraft(emptyTaskDraft(),taskExamples[1]),fromBlock:'101',toBlock:'200',flowVersion:2};let writes=0;
 try{
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>JSON.stringify(saved),setItem:()=>writes++}});
  const fresh=emptyTaskDraft();assert.equal(fresh.kind,'general');assert.equal(fresh.goal,'');assert.equal(fresh.sources,'');assert.equal(fresh.fromBlock,'');assert.equal(fresh.toBlock,'');
  assert.equal(readTaskDraft().kind,'analysis');assert.equal(readTaskDraft().fromBlock,'101');assert.equal(writes,0,'reading a saved draft or opening a new one must not overwrite storage');
 }finally{if(prior)Object.defineProperty(globalThis,'localStorage',prior);else Reflect.deleteProperty(globalThis,'localStorage');}
});

test('only active task parameters reach intent parsing and plan storage',()=>{
 const stale={...emptyTaskDraft(),sources:'https://example.com/reference',fromBlock:'200',toBlock:'100'};
 assert.deepEqual(draftParameters(stale),{sourceUrls:['https://example.com/reference']},'a hidden, even invalid, block range must not affect a general task');
 assert.deepEqual(draftParameters({...stale,kind:'research'}),{sourceUrls:['https://example.com/reference']});
 assert.deepEqual(draftParameters({...stale,kind:'analysis'}),{sourceUrls:[],fromBlock:'200',toBlock:'100'},'a transfer preset must not inherit research sources');
});

test('explicit preset switching preserves price, resets incompatible fields and invalidates the old agreement',()=>{
 const general={...emptyTaskDraft(),goal:'东京五日游攻略',reward:'0.123456',sources:'https://example.com',fromBlock:'10',toBlock:'20',agreement:{deliverable:'旧交付',acceptanceCriteria:['旧标准']},basis:'old'};
 const transfer=presetDraft(general,taskExamples[1]);assert.equal(transfer.reward,general.reward);assert.equal(transfer.kind,'analysis');assert.equal(transfer.sources,'');assert.equal(transfer.fromBlock,'');assert.equal(transfer.agreement,undefined);assert.equal(transfer.basis,undefined);
 const custom=asGeneralDraft({...transfer,fromBlock:'10',toBlock:'20',agreement:general.agreement,basis:'old'});assert.equal(custom.kind,'general');assert.equal(custom.goal,transfer.goal);assert.equal(custom.reward,general.reward);assert.equal(custom.fromBlock,'');assert.equal(custom.toBlock,'');assert.equal(custom.agreement,undefined);
 const research=presetDraft(general,taskExamples[0]);assert.equal(research.kind,'research');assert(research.sources.includes('docs.monad.xyz'));assert.equal(asGeneralDraft(research).sources,research.sources,'research sources become optional references when explicitly switching');
});
