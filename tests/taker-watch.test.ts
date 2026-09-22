import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRun, watchAssignments, type WatchEvent } from '../packages/taker/src/watch.js';
import { TakerClient, TakerApiError, type Assignment, type AssignmentBatch } from '../packages/taker/src/client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTakerMcp } from '../packages/taker/src/mcp.js';

test('paid runner is explicit, keeps a separate cache, and resumes an upload without another purchase',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'taker-paid-'));const id=crypto.randomUUID();let local=0,paid=0,fail=false;
 const run={owner:'0xowner',authorized:true,validUntil:Date.now()/1000+600,attempt:'1',spec:{capability:'analysis.token-transfers'},task:{status:1,attempt:'1',worker:'0xowner',claimLeaseExpiresAt:Date.now()/1000+300}};
 const client={run:async()=>run,claim:async()=>({}),waitClaim:async()=>run,analyze:async()=>{local++;return {output:{source:'local'},provenance:{toolVersion:'test-local/1'}};},purchaseTransfers:async()=>{paid++;return {output:{source:'mpp'},provenance:{toolVersion:'test-mpp/1'}};},upload:async()=>{if(fail){fail=false;throw new Error('lost upload');}},submit:async()=>({status:'queued'})};
 try{await executeRun(client,id,directory);assert.equal(local,1);assert.equal(paid,0);fail=true;await assert.rejects(executeRun(client,id,directory,{paidTools:true}),/lost upload/);await executeRun(client,id,directory,{paidTools:true});assert.equal(paid,1);assert.equal(local,1);}finally{await rm(directory,{recursive:true,force:true});}
});

test('MCP distinguishes a platform-paid purchase from read-only transfer analysis',async()=>{
 const server=createTakerMcp(),client=new Client({name:'test',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
 try{await server.connect(serverTransport);await client.connect(clientTransport);const {tools}=await client.listTools();
  const paid=tools.find(tool=>tool.name==='taker_purchase_transfers')!;assert(paid);assert.equal(paid.annotations?.readOnlyHint,false);assert.equal(paid.annotations?.idempotentHint,true);assert.deepEqual(Object.keys(paid.inputSchema.properties!),['runId']);assert.equal(tools.find(tool=>tool.name==='taker_analyze_transfers')!.annotations?.readOnlyHint,true);
 }finally{await client.close();await server.close();}
});

const assignment=(id:string,version='v1'):Assignment=>({id,version,taskId:'1',attempt:'1',mode:'sponsored',capability:'analysis.token-transfers',validUntil:Date.now()/1000+600,resultHash:null,taskStatus:0,taskAttempt:'0',worker:null,lease:null,claimStatus:null,submitStatus:null});
const batch=(runs:Assignment[],cursor='cursor'):AssignmentBatch=>({runs,cursor,timedOut:false});

test('watch stays idle without assignments, executes serially once, and resumes on changed versions',async()=>{
 const signal=new AbortController();const calls:string[]=[],logs:WatchEvent[]=[];let step=0,active=0,max=0;
 const batches=[batch([]),batch([assignment('a'),assignment('b')]),batch([assignment('a'),assignment('b')]),batch([assignment('a','v2')])];
 await watchAssignments({signal:signal.signal,log:e=>logs.push(e),wait:async()=>{const next=batches[step++];if(!next){signal.abort();return batch([]);}return next;},execute:async id=>{active++;max=Math.max(max,active);calls.push(id);await Promise.resolve();active--;return {state:'submitted'};}});
 assert.deepEqual(calls,['a','b','a']);assert.equal(max,1);assert.equal(logs[0]!.event,'watching');assert.equal(logs.at(-1)!.event,'stopped');
});

test('one execution error does not block other tasks or immediately repeat expensive work',async()=>{
 const signal=new AbortController();let step=0;const calls:string[]=[],logs:WatchEvent[]=[];
 await watchAssignments({signal:signal.signal,log:e=>logs.push(e),wait:async()=>{if(step++===2)signal.abort();return batch([assignment('bad'),assignment('good')]);},execute:async id=>{calls.push(id);if(id==='bad')throw new Error('temporary');return {state:'submitted'};}});
 assert.deepEqual(calls,['bad','good']);assert.equal(logs.filter(e=>e.event==='run-error').length,1);assert.equal(logs.find(e=>e.event==='run-error')!.retryInMs,30000);
});

test('wallet prompts are deduplicated, failed commands need attention, and auth expiry stops watching',async()=>{
 const signal=new AbortController();const logs:WatchEvent[]=[];let step=0,calls=0;
 await watchAssignments({signal:signal.signal,log:e=>logs.push(e),wait:async()=>{if(step++===2)signal.abort();return batch([assignment('wallet'),{...assignment('failed'),claimStatus:'failed'},{...assignment('queued'),submitStatus:'queued'}]);},execute:async()=>{calls++;return {state:'wallet-required'};}});
 assert.equal(calls,1);assert.equal(logs.filter(e=>e.state==='wallet-required').length,1);assert.equal(logs.filter(e=>e.state==='attention').length,1);
 await assert.rejects(watchAssignments({signal:new AbortController().signal,log:()=>{},wait:async()=>{throw new TakerApiError(401,'UNAUTHORIZED','expired');},execute:async()=>({state:'finished'})}),/UNAUTHORIZED/);
});

test('runner avoids unsupported claims, checks attempt ownership and reuses cached execution after upload failure',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'taker-watch-'));const id=crypto.randomUUID();let analyzed=0,claimed=0,uploaded=0,submitted=0,fail=true;
 let run:any={owner:'0xowner',authorized:true,validUntil:Date.now()/1000+600,attempt:'1',spec:{capability:'analysis.token-transfers'},task:{status:1,attempt:'1',worker:'0xowner',claimLeaseExpiresAt:Date.now()/1000+300}};
 const client={run:async()=>run,claim:async()=>{claimed++;return {};},waitClaim:async()=>run,analyze:async()=>{analyzed++;return {output:{ok:true},provenance:{toolVersion:'test/1'}};},upload:async(_id:string,value:unknown)=>{assert.deepEqual(value,{output:{ok:true},provenance:{toolVersion:'test/1'}});uploaded++;if(fail){fail=false;throw new Error('network');}},submit:async()=>{submitted++;return {status:'queued'};}};
 try{
  run.spec.capability='research.web';assert.equal((await executeRun(client,id,directory)).state,'handler-required');assert.equal(claimed,0);
  run.spec.capability='analysis.token-transfers';run.task.worker='other';assert.equal((await executeRun(client,id,directory)).state,'inactive');assert.equal(analyzed,0);
  run.task.worker='0xowner';await assert.rejects(executeRun(client,id,directory),/network/);
  assert.equal((await executeRun(client,id,directory)).state,'submitted');assert.equal(analyzed,1);assert.equal(uploaded,2);assert.equal(submitted,1);
  run.revoked=true;assert.equal((await executeRun(client,id,directory)).state,'inactive');assert.equal(submitted,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('client passes opaque cursor, never puts bearer in URL, and cancels a pending long poll',async()=>{
 const original=globalThis.fetch,controller=new AbortController();const cursor='0x'+'12'.repeat(32);let observed=false;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.pathname,'/platform/taker/runs/wait');assert.equal(url.searchParams.get('cursor'),cursor);assert(!url.href.includes('ab'.repeat(32)));assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+'ab'.repeat(32));observed=true;
  return new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true}));
 };
 try{const waiting=new TakerClient('https://platform.test','ab'.repeat(32),controller.signal).wait(cursor);assert(observed);controller.abort(new Error('stop'));await assert.rejects(waiting,/stop/);}finally{globalThis.fetch=original;}
});
