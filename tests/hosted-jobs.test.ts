import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensureHostedJob,reserveHostedModelRequest} from '../apps/object-store/src/hosted-jobs.js';
import type {RunRow} from '../apps/object-store/src/taker-api.js';
import type {Env} from '../apps/object-store/src/index.js';

test('retired hosted execution cannot create jobs; historical jobs and atomic model allowance remain',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(readFileSync('apps/object-store/platform-schema.sql','utf8'));
 const env:Env={HOSTED:{idFromName:(id:string)=>id,get:()=>({fetch:async()=>new Response('ok')})}as any,DB:{prepare(sql){let values:SQLInputValue[]=[];return{bind(...v){values=v as SQLInputValue[];return this;},async first<T>(){return(db.prepare(sql).get(...values)??null)as T|null;},async run(){return db.prepare(sql).run(...values);}};}}};
 const row=(owner=`0x${'11'.repeat(20)}`)=>({id:crypto.randomUUID(),owner,executor_id:null,task_id:'1',attempt:'1',revoked:0,body:JSON.stringify({hostedAgent:'transfers-v1',spec:{capability:'analysis.token-transfers'},authorized:true,mode:'wallet',validUntil:Math.floor(Date.now()/1000)+600})}as RunRow);
 try{
  const rows=[row(),row(),row()];
  for(const r of rows) await assert.rejects(ensureHostedJob(env,r),/HOSTED_DISABLED/);
  assert.equal(db.prepare('SELECT count(*) n FROM platform_hosted_jobs').get()!.n,0);
  const legacy=rows[0]!;const historical={id:legacy.id,status:'completed'};
  db.prepare('INSERT INTO platform_hosted_jobs(id,owner,agent,body,active,created_at,updated_at) VALUES (?,?,?,?,0,?,?)').run(legacy.id,legacy.owner,'transfers-v1',JSON.stringify(historical),Date.now(),Date.now());
  assert.deepEqual(await ensureHostedJob(env,legacy),historical);
  const requests=await Promise.allSettled(Array.from({length:45},()=>reserveHostedModelRequest(env)));assert.equal(requests.filter(r=>r.status==='fulfilled').length,40);assert.equal(db.prepare("SELECT requests n FROM platform_model_budgets WHERE key LIKE '%:cloudflare:generation'").get()!.n,40);
 }finally{db.close();}
});
