import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runHistory,type RunRow} from '../apps/object-store/src/taker-api.js';
import type {PlatformGoal} from '../apps/object-store/src/platform-domain.js';
test('a rejected taker attempt never inherits the next attempt acceptance or payment',()=>{
 const owner=`0x${'11'.repeat(20)}` as const;const firstHash=`0x${'22'.repeat(32)}` as const;const secondHash=`0x${'33'.repeat(32)}` as const;
 const rejected={verdict:'reject',attempt:'1',resultHash:firstHash};const accepted={verdict:'accept',attempt:'2',resultHash:secondHash};
 const settled={event:'TaskSettled',transactionHash:secondHash,args:{attempt:'2',worker:owner}};
 const goal={evidence:accepted,verificationHistory:[rejected],events:[{event:'accept',attempt:'2',transactionHash:secondHash},settled]} as unknown as PlatformGoal;
 const old={owner,attempt:'1',result_hash:firstHash} as RunRow;
 const oldView=runHistory(old,goal,{attempt:2n,status:3});assert.equal(oldView.evidence.verdict,'reject');assert.equal(oldView.events.length,0);assert(oldView.superseded);
 const newView=runHistory({...old,attempt:'2',result_hash:secondHash},goal,{attempt:2n,status:3});assert.equal(newView.evidence.verdict,'accept');assert(newView.events.includes(settled));assert.equal(newView.superseded,false);
 assert(runHistory(old,goal,{attempt:1n,status:0}).superseded,'reopened attempt must not look like a new claim authorization');
});


test('manual result validation identifies provenance field paths without leaking submitted values', async()=>{
 const {executionSchema}=await import('../apps/object-store/src/taker-api.js');
 const {inputIssues}=await import('../apps/object-store/src/input-errors.js');
 const invalid=executionSchema.safeParse({output:{summary:'kept unchanged'},provenance:{mode:'llm',sources:[{url:'https://docs.monad.xyz/',fetchedAt:'2026-09-19T14:40:00Z'}],privateNote:'do-not-echo-this-value'}});
 assert.equal(invalid.success,false);if(invalid.success)return;
 const issues=inputIssues(invalid.error);assert(issues.some(i=>i.field==='provenance.toolVersion'));assert(issues.some(i=>i.field==='provenance.sources.0.uri'));assert(issues.some(i=>i.field==='provenance.sources.0.contentHash'));
 assert(!JSON.stringify(issues).includes('do-not-echo-this-value'));
 assert(executionSchema.safeParse({output:{},provenance:{toolVersion:'manual-source-check/1',sources:[{uri:'https://docs.monad.xyz/developer-essentials/eip-7702.md',retrievedAt:1789832533,contentHash:'0x'+'ab'.repeat(32)}]}}).success);
});
