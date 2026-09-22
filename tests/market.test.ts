import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {keccak256,stringToHex} from 'viem';
import {marketList} from '../apps/object-store/src/market-query.js';
import {activityState,platformActivity,markActivityRead} from '../apps/object-store/src/platform-activity.js';
import {platformApi} from '../apps/object-store/src/platform-api.js';
import type {Env} from '../apps/object-store/src/index.js';
function fixture(){const db=new DatabaseSync(':memory:');db.exec(readFileSync('apps/object-store/platform-schema.sql','utf8'));const env:Env={DB:{prepare(sql){let values:SQLInputValue[]=[];return{bind(...v){values=v as SQLInputValue[];return this;},async first<T>(){return (db.prepare(sql).get(...values)??null) as T|null;},async run(){return db.prepare(sql).run(...values);}};}}};return {db,env};}
const owner=`0x${'11'.repeat(20)}`,other=`0x${'22'.repeat(20)}`;const hash=`0x${'33'.repeat(32)}`;const now=Date.now();
const goal=(id:string,status=0)=>({id,owner,taskId:id,input:{goal:`研究 ${id}`,execution:'market',reward:'50000'},spec:{capability:'research.web'},status:'running',task:{status,attempt:'1',worker:owner,resultHash:hash,taskDeadline:Math.floor(now/1000)+3600,claimLeaseExpiresAt:Math.floor(now/1000)+300,reviewDeadline:Math.floor(now/1000)+600}});
test('market filters run before the 60-item window, bound search and exclude expired open tasks',async()=>{
 const {db,env}=fixture();try{
 for(let i=1;i<=70;i++){const g=goal(String(i));if(i===1){g.input.goal='needle % quote\'';g.input.reward='200000';}db.prepare('INSERT INTO platform_goals(id,owner,body,updated_at) VALUES (?,?,?,?)').run(g.id,owner,JSON.stringify(g),i);}
 assert.equal((await marketList(env,new URLSearchParams('state=open'),now)).total,70);
 assert.equal((await marketList(env,new URLSearchParams('q=needle'),now)).tasks[0].taskId,'1','search must find a match outside unfiltered recent 60');
 assert.equal((await marketList(env,new URLSearchParams('sort=reward'),now)).tasks[0].taskId,'1');
 assert.equal((await marketList(env,new URLSearchParams("q=%27%20OR%201%3D1%20--"),now)).total,0);
 const expired=goal('71');expired.task.taskDeadline=Math.floor(now/1000)-1;db.prepare('INSERT INTO platform_goals(id,owner,body,updated_at) VALUES (?,?,?,?)').run('71',owner,JSON.stringify(expired),71);
 assert.equal((await marketList(env,new URLSearchParams('state=open'),now)).total,70);
 await assert.rejects(marketList(env,new URLSearchParams('sort=DROP_TABLE')));await assert.rejects(marketList(env,new URLSearchParams({q:'x'.repeat(101)})));
 }finally{db.close();}
});
test('activity never attributes another worker or later attempt settlement to an old run',()=>{
 const run={owner,attempt:'1',result_hash:hash,revoked:0,body:JSON.stringify({authorized:true,mode:'wallet',validUntil:now/1000+600})};const g=goal('1',3);g.task.attempt='2';assert.equal(activityState(g,run,undefined,now)?.state,'superseded');g.task.attempt='1';g.task.worker=other;assert.equal(activityState(g,run,undefined,now)?.state,'superseded');g.task.worker=owner;
 assert.match(activityState(g,run,undefined,now)!.message,/不代表质量/);g.task.status=1;g.task.claimLeaseExpiresAt=Math.floor(now/1000);assert.equal(activityState(g,run,undefined,now)?.state,'lease-expired');g.task.status=2;g.task.reviewDeadline=Math.floor(now/1000);assert.equal(activityState(g,run,undefined,now)?.state,'review-timeout');
});
test('activity reads are isolated, idempotent and new attempt states reappear unread',async()=>{
 const {db,env}=fixture();try{
 const a=goal('1',2),b={...goal('2',2),owner:other};for(const g of [a,b])db.prepare('INSERT INTO platform_goals(id,owner,body,updated_at) VALUES (?,?,?,?)').run(g.id,g.owner,JSON.stringify(g),now);
 const own=await platformActivity(env,owner,now),foreign=await platformActivity(env,other,now);assert.equal(own.length,1);assert.equal(own[0]!.taskId,'1');
 await markActivityRead(env,owner,[foreign[0]!.id,own[0]!.id,own[0]!.id]);assert.equal((await platformActivity(env,owner,now))[0]!.read,true);assert.equal((await platformActivity(env,other,now))[0]!.read,false);assert.equal(db.prepare('SELECT count(*) n FROM platform_activity_reads').get()!.n,1);
 a.task.attempt='2';db.prepare('UPDATE platform_goals SET body=? WHERE id=?').run(JSON.stringify(a),'1');assert.equal((await platformActivity(env,owner,now))[0]!.read,false);
 const id=crypto.randomUUID();db.prepare('INSERT INTO platform_runs(id,owner,task_id,attempt,body,result_hash,created_at) VALUES (?,?,?,?,?,?,?)').run(id,other,'1','1',JSON.stringify({authorized:true,validUntil:now/1000+3600,mode:'wallet'}),hash,now);
 const items=await platformActivity(env,other,now);assert.equal(items.find(i=>i.targetId===id)!.state,'superseded');assert(!JSON.stringify(items).includes('claimPermission'));
 }finally{db.close();}
});
test('notification APIs require own session and reject cross-origin writes',async()=>{
 const {db,env}=fixture();try{
 env.PLATFORM={} as any;env.PLATFORM_CONFIG=JSON.stringify({chainId:10143,manager:owner,factory:owner,worker:owner,sponsor:owner,operator:owner,token:owner,rpcUrl:'https://rpc.example.test',storageUrl:'https://platform.test'});
 const token='ab'.repeat(32);db.prepare('INSERT INTO platform_sessions(hash,address,expires_at) VALUES (?,?,?)').run(keccak256(stringToHex(token)),owner,now+3600000);
 assert.equal((await platformApi(new Request('https://platform.test/platform/activity'),env)).status,401);
 const cookie=`worknet_user=${token}`;assert.equal((await platformApi(new Request('https://platform.test/platform/activity',{headers:{cookie}}),env)).status,200);
 assert.equal((await platformApi(new Request('https://platform.test/platform/activity/read',{method:'POST',headers:{cookie,origin:'https://evil.test','content-type':'application/json'},body:'{"ids":[]}'}),env)).status,403);
 }finally{db.close();}
});
