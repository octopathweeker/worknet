import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { keccak256, stringToHex } from 'viem';
import { platformApi } from '../apps/object-store/src/platform-api.js';
import { transferAgreement } from '../apps/object-store/src/platform-domain.js';
import type { Env } from '../apps/object-store/src/index.js';

const address=`0x${'11'.repeat(20)}`;
const agreement={deliverable:'东京五日行程、交通与预算估算。',acceptanceCriteria:['覆盖五天行程。','每天最多三个主要景点。'],intent:{version:'worknet-intent/1',objective:'规划适合慢节奏出行的东京五日游。',constraints:['每天最多三个主要景点。'],assumptions:['未指定出行日期。'],evidenceRequirements:['时效性信息附来源，并说明估算。']}};
function fixture() {
 const db=new DatabaseSync(':memory:');db.exec(readFileSync('apps/object-store/platform-schema.sql','utf8'));
 const token='ab'.repeat(32);db.prepare('INSERT INTO platform_users(address,vault,created_at) VALUES (?,?,?)').run(address,address,Date.now());
 db.prepare('INSERT INTO platform_sessions(hash,address,expires_at) VALUES (?,?,?)').run(keccak256(stringToHex(token)),address,Date.now()+600000);
 const config={chainId:10143,manager:address,factory:address,token:address,operator:address,worker:address,sponsor:address,rpcUrl:'https://rpc.test',storageUrl:'https://worknet.test',quorum:{judges:[address,`0x${'22'.repeat(20)}`],threshold:2}};
 let modelCalls=0;
 const env:Env={PLATFORM_CONFIG:JSON.stringify(config),PLATFORM:{idFromName:()=>1,get:()=>({fetch:async()=>{throw new Error('confirmation must not publish');}})} as any,JUDGE_SERVICE_TOKEN:'j'.repeat(32),JUDGE_1:{fetch:async()=>{throw new Error('review is for delivery');}},JUDGE_2:{fetch:async()=>{throw new Error('review is for delivery');}},PLATFORM_AI_MODEL:'fixture',AI:{run:async()=>{modelCalls++;return{response:{status:'ready',kind:'general'}};}} as any,DB:{prepare(sql){let args:SQLInputValue[]=[];return{bind(...values){args=values as SQLInputValue[];return this;},async first<T>(){return(db.prepare(sql).get(...args)??null)as T|null;},async run(){return db.prepare(sql).run(...args);}};}}};
 const call=(body:unknown)=>platformApi(new Request(config.storageUrl+'/platform/plans',{method:'POST',headers:{origin:config.storageUrl,'content-type':'application/json',cookie:`worknet_user=${token}`},body:JSON.stringify(body)}),env);
 return{db,env,config,call,get modelCalls(){return modelCalls;}};
}
const plan=()=>({id:crypto.randomUUID(),goal:'帮我制定东京五日游攻略，行程轻松一些。',kind:'general',execution:'market',reward:'50000',agreement});

test('confirming a user-edited intent never regenerates it, even if the generation model is malformed or unavailable',async()=>{
 const f=fixture();try{
  const input=plan();const response=await f.call(input);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  const saved=await response.json() as any;assert.deepEqual(saved.input.agreement,agreement);assert.equal(saved.status,'draft');assert.equal(saved.taskId,undefined);assert.equal(f.modelCalls,0);
  assert.equal((await f.call(input)).status,200);assert.equal(f.modelCalls,0);
  assert.equal((await f.call({...input,agreement:{...agreement,deliverable:'新交付物'}})).status,409);
  assert.deepEqual(JSON.parse(String(f.db.prepare('SELECT body FROM platform_goals WHERE id=?').get(input.id)!.body)).input.agreement,agreement);
  delete f.env.AI;delete f.env.PLATFORM_AI_MODEL;
  assert.equal((await f.call(plan())).status,200,'confirmed intent does not require another model call');
  assert.equal(f.db.prepare('SELECT count(*) n FROM platform_goals').get()!.n,2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM platform_commands').get()!.n,0,'confirmation must not escrow or launch');
 }finally{f.db.close();}
});

test('deterministic confirmation retains intent, reward and multi-node validation',async()=>{
 const f=fixture();try{
  for(const input of [
   {...plan(),agreement:{deliverable:'仅有交付物',acceptanceCriteria:['覆盖五天']}},
   {...plan(),agreement:{...agreement,acceptanceCriteria:[]}},
   {...plan(),agreement:{...agreement,intent:{...agreement.intent,constraints:Array(9).fill('超出项数')}}},
   {...plan(),reward:'999999'},
   {...plan(),execution:'platform'},
  ])assert.equal((await f.call(input)).status,400);
  f.env.PLATFORM_CONFIG=JSON.stringify({...f.config,quorum:{...f.config.quorum,threshold:1}});
  assert.equal((await f.call(plan())).status,400,'general plans still require multiple Jev signatures');
  assert.equal(f.db.prepare('SELECT count(*) n FROM platform_goals').get()!.n,0);assert.equal(f.modelCalls,0);
 }finally{f.db.close();}
});

test('preset confirmation preserves the fixed transfer rules and allowed research sources without regeneration',async()=>{
 const f=fixture();try{
  const research={...plan(),kind:'research',sourceUrls:['https://docs.monad.xyz/developer-essentials/eip-7702.md'],agreement:{deliverable:'授权流程说明',acceptanceCriteria:['每项结论附精确引文。']}};
  assert.equal((await f.call(research)).status,200);
  assert.equal((await f.call({...research,id:crypto.randomUUID(),sourceUrls:['https://example.com']})).status,400);
  const analysis={...plan(),kind:'analysis',agreement:transferAgreement};assert.equal((await f.call(analysis)).status,200);
  assert.equal((await f.call({...analysis,id:crypto.randomUUID(),agreement:{...transferAgreement,acceptanceCriteria:['额外指标']}})).status,400);
  assert.equal(f.modelCalls,0);
 }finally{f.db.close();}
});
