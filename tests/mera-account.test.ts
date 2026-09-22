import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { recoverMessageAddress, recoverTypedDataAddress, bytesToHex } from 'viem';
import { exactPermission,permissionTypedData } from '@agent-task/accounts';
import { enterMera,lockMera,meraMetadata,createPrivateDelivery,unlockDelivery } from '../apps/explorer/src/mera-account.js';
import { deliveryPublicKey,sealOutput,deliveryContext } from '@agent-task/privacy';

test('Mera SDK creates and restores one account, signs existing permissions, and reconstructs isolated delivery keys',{timeout:10000},async()=>{
 // Simulated PRF authenticator. This verifies the actual SDK integration, not hardware support.
 const names=['navigator','location','localStorage','isSecureContext'] as const;
 const originals=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 const storage=new Map<string,string>();let calls=0;
 const credential=async(options:any)=>{
  const publicKey=options.publicKey;assert(publicKey.authenticatorSelection?.userVerification==='required'||publicKey.userVerification==='required');
  const salt=publicKey.extensions.prf.eval.first;assert.equal(salt.length,32);calls++;
  const output=new Uint8Array(createHmac('sha256','simulated-authenticator-secret').update(salt).digest());
  return{type:'public-key',rawId:new Uint8Array([1,2,3,4]).buffer,response:{getTransports:()=>['internal']},getClientExtensionResults:()=>({prf:{enabled:true,results:{first:output.buffer}}})};
 };
 try{
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{credentials:{create:credential,get:credential}}});
  Object.defineProperty(globalThis,'location',{configurable:true,value:{hostname:'worknet.test'}});
  Object.defineProperty(globalThis,'isSecureContext',{configurable:true,value:true});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v)}});
  const first=await enterMera('create');const address=first.address;
  assert.equal(await recoverMessageAddress({message:'login nonce',signature:await first.signMessage({message:'login nonce'})}),address);
  const permit=exactPermission(address,`0x${'11'.repeat(20)}`,[{target:`0x${'22'.repeat(20)}`,value:0n,callData:'0x12345678'}],'fixture',2000000000);
  const typed=permissionTypedData(permit);assert.equal(await recoverTypedDataAddress({...typed,signature:await first.signTypedData(typed)}),address);
  assert(first.signAuthorization);const auth=await first.signAuthorization!({address:`0x${'33'.repeat(20)}`,chainId:10143,nonce:0});assert.equal(auth.chainId,10143);
  const persisted=JSON.parse([...storage.values()][0]!);assert.deepEqual(Object.keys(persisted).sort(),['address','credential','rpId','version']);assert.equal(meraMetadata()?.address,address);
  lockMera();await assert.rejects(first.signMessage({message:'ended'}));
  // A fresh device has no local metadata or saved key; the same discoverable passkey restores it.
  storage.clear();const recovered=await enterMera('signin');assert.equal(recovered.address,address);
  const reviewer=deliveryPublicKey(new Uint8Array(32).fill(8));
  const a=await createPrivateDelivery(address,'task-a',reviewer),b=await createPrivateDelivery(address,'task-b',reviewer);
  assert.notEqual(a.publicKey,b.publicKey);
  const binding={specHash:`0x${'44'.repeat(32)}`,taskId:'1',attempt:'1',worker:address};
  const sealed=await sealOutput({summary:'PRIVATE_PASSKEY_REPORT'},a,deliveryContext(binding));
  assert.deepEqual(await unlockDelivery(a,{...binding,output:sealed.output}),{summary:'PRIVATE_PASSKEY_REPORT'});
  await assert.rejects(unlockDelivery(b,{...binding,output:sealed.output}));
  assert(!JSON.stringify([...storage.entries()]).includes('PRIVATE_PASSKEY_REPORT'));
  assert(calls>=6);
 } finally {lockMera();for(const name of names){const descriptor=originals.get(name);if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}}
});
