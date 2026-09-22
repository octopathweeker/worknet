import assert from 'node:assert/strict';
import {test} from 'node:test';
import {coordinatorDelay} from '../apps/object-store/src/resource-scheduling.js';
import {visiblePolling} from '../apps/explorer/src/polling.js';

test('waiting tasks back off, due commands remain responsive and chain deadlines shorten the delay',()=>{
 const now=100000;assert.equal(coordinatorDelay(0,0,null,now),60000);assert.equal(coordinatorDelay(0,5,null,now),15000);assert.equal(coordinatorDelay(1,5,null,now),1500);assert.equal(coordinatorDelay(0,5,103,now),3000);assert.equal(coordinatorDelay(0,5,99,now),1000);
});
test('hidden pages stop polling; return refreshes once and in-flight batches never overlap',async()=>{
 const target=new EventTarget()as EventTarget&{hidden:boolean};target.hidden=true;
 const prior=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:target,configurable:true});
 let count=0,active=0,max=0,release:(()=>void)|undefined;
 const stop=visiblePolling(async()=>{count++;active++;max=Math.max(max,active);await new Promise<void>(r=>release=r);active--;},()=>10);
 try{
  assert.equal(count,0);target.hidden=false;target.dispatchEvent(new Event('visibilitychange'));assert.equal(count,1);
  target.dispatchEvent(new Event('visibilitychange'));assert.equal(count,1);target.hidden=true;target.dispatchEvent(new Event('visibilitychange'));release!();await new Promise(r=>setTimeout(r,30));assert.equal(count,1);
  target.hidden=false;target.dispatchEvent(new Event('visibilitychange'));assert.equal(count,2);stop();release!();await new Promise(r=>setTimeout(r,30));assert.equal(count,2);assert.equal(max,1);
 }finally{stop();if(prior)Object.defineProperty(globalThis,'document',prior);else Reflect.deleteProperty(globalThis,'document');}
});
