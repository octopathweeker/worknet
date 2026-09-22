import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {callPlatformModel,freeModels,reserveModelAttempt,taskModelUsage} from '../apps/object-store/src/model-gateway.js';
import type {Env} from '../apps/object-store/src/index.js';
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(readFileSync('apps/object-store/platform-schema.sql','utf8'));
 const env:Env={PLATFORM_GENERATION_PROVIDER:'openrouter',OPENROUTER_API_KEY:'fixture-key-not-a-credential',OPENROUTER_FREE_MODELS:'fixture/a:free,fixture/b:free',DB:{prepare(sql){let values:SQLInputValue[]=[];return{bind(...v){values=v as SQLInputValue[];return this;},async first<T>(){return(db.prepare(sql).get(...values)??null)as T|null;},async run(){return db.prepare(sql).run(...values);}};}}};
 return {db,env};
}
const catalog=(paid=false)=>new Response(JSON.stringify({data:['fixture/a:free','fixture/b:free'].map(id=>({id,pricing:{prompt:paid?'0.1':'0',completion:'0',request:'0'},supported_parameters:['response_format']}))}));
test('free-only model fallback enforces zero pricing, isolates review and records actual attempts without content',async()=>{
 const {db,env}=fixture(),original=globalThis.fetch;let calls:any[]=[],cf=0;
 env.AI={run:async()=>{cf++;return {response:{accept:true},usage:{prompt_tokens:10,completion_tokens:4}}}}as any;env.PLATFORM_JUDGE_MODEL='fixture-judge';
 try{
  globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/models'))return catalog();const body=JSON.parse(String(init?.body));calls.push(body);if(calls.length===1)return new Response('upstream private error',{status:429});return new Response(JSON.stringify({model:body.model.replace(':free',''),choices:[{message:{content:'{"summary":"valid"}'}}],usage:{prompt_tokens:42,completion_tokens:8,cost:0}}));};
  const context={owner:'owner-a',taskId:'1',attempt:'1',runId:'run-a'};
  const result=await callPlatformModel(env,'private system',{secretContext:'never log this'},'generation',{context});
  assert.equal(result.model,'fixture/b:free');assert.equal(cf,0);assert.equal(calls.length,2);
  for(const c of calls){assert(c.model.endsWith(':free'));assert.deepEqual(c.provider.max_price,{prompt:0,completion:0,request:0,image:0});assert.deepEqual(c.plugins,[]);assert.equal(c.models,undefined);}
  const usage=await taskModelUsage(env,'1','1');assert.equal(usage.reduce((n:number,x:any)=>n+x.requests,0),2);assert.equal(usage.find((x:any)=>x.model==='fixture/b:free').inputTokens,42);
  assert(!JSON.stringify(db.prepare('SELECT * FROM platform_model_calls').all()).includes('never log this'));assert(!JSON.stringify(db.prepare('SELECT * FROM platform_model_calls').all()).includes('fixture-key'));
  await callPlatformModel(env,'review',{},'quotation-review',{context});await callPlatformModel(env,'review',{},'delivery-review',{context});assert.equal(cf,2);assert.equal(calls.length,2,'review must remain on CF');
  assert.deepEqual(await taskModelUsage(env,'2','1'),[]);
 }finally{globalThis.fetch=original;db.close();}
});
test('paid/configured routers, changed catalog prices, exhausted fallbacks and credentials fail closed',async()=>{
 const {db,env}=fixture(),original=globalThis.fetch;let paidCalls=0,cf=0;
 env.AI={run:async()=>{cf++;return{response:{}}}}as any;
 try{
  for(const id of ['fixture/paid','openrouter/free','fixture/a:free,fixture/b'])assert.throws(()=>freeModels({...env,OPENROUTER_FREE_MODELS:id}),/MODEL_FREE_ONLY/);
  globalThis.fetch=async url=>{if(String(url).endsWith('/models'))return catalog(true);paidCalls++;throw new Error('must never call');};
  await assert.rejects(callPlatformModel(env,'',{},'generation'),/MODEL_NO_FREE_PROVIDER/);assert.equal(paidCalls,0);
  let attempts=0;globalThis.fetch=async url=>{if(String(url).endsWith('/models'))return catalog();attempts++;return new Response('provider down',{status:503});};
  await assert.rejects(callPlatformModel(env,'',{},'generation'),/MODEL_FREE_UNAVAILABLE/);assert.equal(attempts,2);assert.equal(cf,0);
  attempts=0;globalThis.fetch=async url=>{if(String(url).endsWith('/models'))return catalog();attempts++;return new Response('private key error',{status:401});};
  await assert.rejects(callPlatformModel(env,'',{},'generation'),/MODEL_ACCESS_UNAVAILABLE/);assert.equal(attempts,1);
  for(const response of [{model:'fixture/a:free',usage:{cost:0.01}},{model:'fixture/paid',usage:{cost:0}}]){
   attempts=0;globalThis.fetch=async url=>{if(String(url).endsWith('/models'))return catalog();attempts++;return new Response(JSON.stringify({...response,choices:[{message:{content:'{}'}}]}));};
   await assert.rejects(callPlatformModel(env,'',{},'generation'),/MODEL_POLICY_VIOLATION/);assert.equal(attempts,1,'policy mismatch must stop, not try another provider');
  }
 }finally{globalThis.fetch=original;db.close();}
});
test('global generation cap is atomic and cannot consume the separate review allowance',async()=>{
 const{db,env}=fixture();try{
  const results=await Promise.allSettled(Array.from({length:45},()=>reserveModelAttempt(env,'cloudflare','generation')));assert.equal(results.filter(r=>r.status==='fulfilled').length,40);
  await reserveModelAttempt(env,'cloudflare','quotation-review');await reserveModelAttempt(env,'cloudflare','delivery-review');
  const reviews=db.prepare("SELECT requests FROM platform_model_budgets WHERE key LIKE '%:review'").get();assert.equal(reviews!.requests,2);
 }finally{db.close();}
});
test('cancelled inference never returns a late provider result or starts a fallback',async()=>{
 const{db,env}=fixture(),original=globalThis.fetch,controller=new AbortController();let requests=0;
 try{
  globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/models'))return catalog();requests++;return new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true});controller.abort(new Error('user stop'));});};
  await assert.rejects(callPlatformModel(env,'',{},'generation',{signal:controller.signal}),/user stop/);assert.equal(requests,1);assert.equal(db.prepare('SELECT status FROM platform_model_calls').get()!.status,'interrupted');
 }finally{globalThis.fetch=original;db.close();}
});
test('workerd-compatible manual redirect mode never follows catalog or authenticated redirects',async()=>{
 const{db,env}=fixture(),original=globalThis.fetch;let requests=0;
 try{
  globalThis.fetch=async(_url,init)=>{requests++;assert.equal(init?.redirect,'manual');return new Response(null,{status:302,headers:{location:'https://untrusted.test/collect'}});};
  await assert.rejects(callPlatformModel(env,'',{},'generation'),/MODEL_CATALOG_HTTP_302/);assert.equal(requests,1);
  requests=0;globalThis.fetch=async(url,init)=>{assert.equal(init?.redirect,'manual');if(String(url).endsWith('/models'))return catalog();requests++;assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');return new Response(null,{status:307,headers:{location:'https://untrusted.test/collect'}});};
  await assert.rejects(callPlatformModel(env,'',{},'generation'),/MODEL_FREE_UNAVAILABLE/);assert.equal(requests,2);
 }finally{globalThis.fetch=original;db.close();}
});
