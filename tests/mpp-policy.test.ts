import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { toolPaymentConfigSchema, validateToolChallenge, verifyPaymentReceipt } from '../apps/object-store/src/mpp-policy.js';
import { reserveToolPayment, type ToolRequest } from '../apps/object-store/src/tool-payments.js';
import type { Env } from '../apps/object-store/src/index.js';
import type { IdentitySnapshot } from '@agent-task/identity';
const require=createRequire(new URL('../apps/object-store/package.json',import.meta.url));
const {Challenge,Receipt}=await import(require.resolve('mppx'));
const payer=`0x${'11'.repeat(20)}` as const,token=`0x${'22'.repeat(20)}` as const;
const identity:IdentitySnapshot={ref:{chainId:'10143',registry:`0x${'33'.repeat(20)}`,agentId:'1'},owner:payer,agentWallet:payer,agentURI:'https://provider.test/services/agent.json',blockNumber:'123',blockHash:`0x${'44'.repeat(32)}`};
const policy=toolPaymentConfigSchema.parse({endpoint:'https://provider.test/services/transfers',provider:identity.ref,maxPerCall:'1000',maxPerTask:'1500',maxPerDay:'2000',maxGasWei:'1000000000000000'});
function response(update:any={}){const c=Challenge.from({id:'fixture',method:'monad',intent:'charge',realm:'provider.test',expires:new Date(Date.now()+300000).toISOString(),request:{amount:'1000',currency:token,recipient:payer,methodDetails:{chainId:10143},...update.request},...Object.fromEntries(Object.entries(update).filter(([k])=>k!=='request'))});return new Response(null,{status:402,headers:{'www-authenticate':Challenge.serialize(c)}});}
test('MPP inspects chain, price, recipient, currency, expiry and realm before any signing',()=>{
 assert.equal(validateToolChallenge(response(),policy,identity,token).request.amount,'1000');
 for(const change of [{method:'tempo'},{realm:'evil.test'},{header:'x-other'},{expires:new Date(0).toISOString()},{request:{amount:'1001'}},{request:{amount:'0'}},{request:{methodDetails:{chainId:143}}},{request:{currency:payer}},{request:{recipient:token}}])assert.throws(()=>validateToolChallenge(response(change),policy,identity,token));
 assert.throws(()=>validateToolChallenge(new Response(null,{status:302}),policy,identity,token));
 const hash=`0x${'66'.repeat(32)}` as const;
 const receipt=Receipt.serialize({method:'monad',status:'success',reference:hash,timestamp:new Date().toISOString()});
 assert.equal(verifyPaymentReceipt(new Response('{}',{headers:{'payment-receipt':receipt}}),hash).reference,hash);
 assert.throws(()=>verifyPaymentReceipt(new Response('{}'),hash));
 assert.throws(()=>verifyPaymentReceipt(new Response('{}',{headers:{'payment-receipt':receipt}}),`0x${'77'.repeat(32)}`));
});
test('tool fee reservations are atomic across users, attempts and duplicate requests',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(readFileSync('apps/object-store/platform-schema.sql','utf8'));
 const env:Env={DB:{prepare(sql){let args:SQLInputValue[]=[];return{bind(...v){args=v as SQLInputValue[];return this;},async first<T>(){return(db.prepare(sql).get(...args)??null) as T|null;},async run(){return db.prepare(sql).run(...args);}};}}};
 const input:ToolRequest={owner:payer,taskId:'1',attempt:'1',specHash:`0x${'88'.repeat(32)}`,input:{sourceChainId:'10143',token,fromBlock:'1',toBlock:'2'}};
 try{
  await reserveToolPayment(env,'one',input,'1000',policy,payer,identity);await reserveToolPayment(env,'one',input,'1000',policy,payer,identity);
  await assert.rejects(reserveToolPayment(env,'one',input,'999',policy,payer,identity),/RESERVATION_CONFLICT/);
  await assert.rejects(reserveToolPayment(env,'attempt-2',{...input,attempt:'2'},'1000',policy,payer,identity),/BUDGET/);
  const attempts=await Promise.allSettled([2,3,4].map(i=>reserveToolPayment(env,`task-${i}`,{...input,taskId:String(i)},'1000',policy,payer,identity)));
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(db.prepare('SELECT sum(amount) n FROM platform_tool_payments').get()!.n,2000);
 }finally{db.close();}
});
