import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHmac} from 'node:crypto';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {quicknodeWebhook,verifyQuicknode} from '../apps/object-store/src/quicknode-webhook.js';
import {platformApi,platformConfig} from '../apps/object-store/src/platform-api.js';
import type {Env} from '../apps/object-store/src/index.js';
const secret='fixture-secret-not-a-real-credential';
const signed=(body='{"event":"hint only"}',nonce=crypto.randomUUID(),at=Date.now())=>{const timestamp=String(Math.floor(at/1000));return new Request('https://platform.test/webhooks/quicknode',{method:'POST',headers:{'x-qn-nonce':nonce,'x-qn-timestamp':timestamp,'x-qn-signature':createHmac('sha256',secret).update(nonce+timestamp+body).digest('hex'),'content-type':'application/json'},body});};
test('QuickNode notifications authenticate, reject stale/tampered/compressed payloads and retry durable wakes safely',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(readFileSync('apps/object-store/platform-schema.sql','utf8'));let wakes=0,available=false;
 const env:Env={QUICKNODE_WEBHOOK_SECRET:secret,PLATFORM:{idFromName:()=>1,get:()=>({fetch:async()=>{wakes++;return new Response(null,{status:available?200:503});}})}as any,DB:{prepare(sql){let values:SQLInputValue[]=[];return{bind(...v){values=v as SQLInputValue[];return this;},async first<T>(){return(db.prepare(sql).get(...values)??null)as T|null;},async run(){return db.prepare(sql).run(...values);}};}}};
 try{
  await assert.rejects(verifyQuicknode(signed('{}',undefined,Date.now()-600000),secret));
  const altered=signed();await assert.rejects(verifyQuicknode(new Request(altered.url,{method:'POST',headers:altered.headers,body:'{}'}),secret));
  const compressed=signed();compressed.headers.set('content-encoding','gzip');await assert.rejects(verifyQuicknode(compressed,secret));
  const nonce=crypto.randomUUID();assert.equal((await quicknodeWebhook(signed('{}',nonce),env)).status,503);assert.equal(db.prepare('SELECT count(*) n FROM platform_webhook_receipts').get()!.n,0);
  available=true;const req=signed('{}',nonce);const retry=req.clone();assert.equal((await quicknodeWebhook(req,env)).status,204);assert.equal((await quicknodeWebhook(retry,env)).status,204);assert.equal(wakes,2);
  assert.equal(db.prepare('SELECT count(*) n FROM platform_events').get()!.n,0,'webhook never inserts provider payload as chain truth');
 }finally{db.close();}
});
test('QuickNode RPC override stays server-side and invalid endpoints do not silently fall back',async()=>{
 const config={chainId:10143,manager:'m',factory:'f',operator:'o',sponsor:'s',worker:'w',rpcUrl:'https://public.test',storageUrl:'https://platform.test'};
 const env:Env={PLATFORM_CONFIG:JSON.stringify(config),QUICKNODE_RPC_URL:'https://fixture.quiknode.pro/private-token/',PLATFORM:{}as any,DB:{prepare(){return{bind(){return this;},async first<T>(){return null as T|null;},async run(){}};}}};
 assert.equal(platformConfig(env).rpcUrl,env.QUICKNODE_RPC_URL);
 const response=await platformApi(new Request('https://platform.test/platform/config'),env);const text=await response.text();assert(!text.includes('private-token'));assert(!text.includes('quiknode.pro'));assert(text.includes('quicknode'));
 for(const url of ['http://fixture.quiknode.pro/key','https://fixture.quiknode.pro.attacker.test/key','invalid'])assert.throws(()=>platformConfig({...env,QUICKNODE_RPC_URL:url}),/QUICKNODE_CONFIG_INVALID/);
});
