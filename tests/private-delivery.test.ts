import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { bytesToHex } from 'viem';
import { hashJson } from '@agent-task/protocol/json';
import { validateTaskSpec, type ResultManifest, type TaskSpec } from '@agent-task/protocol';
import { deliveryPrivateKey, deliveryPublicKey, deliverySalt, deliveryContext, sealOutput, sealJson, openJson, verifiedOpening, verifyRecipientEnvelope, type Opening } from '@agent-task/privacy';
import { deriveAccountPrivateKey } from '../apps/explorer/src/mera-account.js';
import { protectResult, reviewOpening, sealCheckpoint, openCheckpoint, publicPrivateEvidence } from '../apps/object-store/src/private-deliveries.js';
import { validateBinding, judgeOutput } from '../packages/judging/src/index.js';
import type { Env } from '../apps/object-store/src/index.js';

const customer=deliveryPrivateKey(new Uint8Array(32).fill(1)),reviewer=new Uint8Array(32).fill(2);
const delivery={scheme:'worknet-delivery/1' as const,salt:deliverySalt('worknet.test','0xabc','task-a'),publicKey:deliveryPublicKey(customer),reviewPublicKey:deliveryPublicKey(reviewer),rpId:'worknet.test'};
test('task namespaces and wallet derivation are stable and separated; caller-owned PRF is not modified',()=>{
 const prf=new Uint8Array(32).fill(7),copy=prf.slice();
 assert.deepEqual(deriveAccountPrivateKey(prf),deriveAccountPrivateKey(prf));
 assert.notDeepEqual(deriveAccountPrivateKey(prf),deliveryPrivateKey(prf));
 assert.deepEqual(prf,copy);
 assert.equal(deliverySalt('worknet.test','0xAbC','a'),deliverySalt('worknet.test','0xabc','a'));
 for(const other of [deliverySalt('worknet.test','0xabc','b'),deliverySalt('other.test','0xabc','a'),deliverySalt('worknet.test','0xdef','a')])assert.notEqual(other,deliverySalt('worknet.test','0xabc','a'));
});
test('recipient recovers report; reviewer verifies the same ciphertext; key/context/ciphertext substitution fails',async()=>{
 const output={summary:'PRIVATE_REPORT_SENTINEL',findings:[{claim:'private detail'}]};
 const context='task:1:attempt:2';const sealed=await sealOutput(output,delivery,context);
 assert(!JSON.stringify(sealed).includes('PRIVATE_REPORT_SENTINEL'));
 const ownerOpening=await openJson(sealed.output.envelope,customer,context) as Opening;
 const review=await openJson(sealed.review,reviewer,context) as Opening;
 assert.deepEqual(verifiedOpening(sealed.output,ownerOpening),output);assert.deepEqual(review,ownerOpening);
 await verifyRecipientEnvelope(sealed.output,review,context);
 await assert.rejects(openJson(sealed.output.envelope,new Uint8Array(32).fill(3),context));
 await assert.rejects(openJson(sealed.output.envelope,customer,'other-task'));
 assert.throws(()=>verifiedOpening(sealed.output,{...review,output:{summary:'changed'}}),/COMMITMENT/);
 const wrongCipher=await sealJson({output:'wrong',nonce:review.nonce},delivery.publicKey,context);
 await assert.rejects(verifyRecipientEnvelope({...sealed.output,envelope:wrongCipher},review,context));
 const changed={...sealed.output,envelope:{...sealed.output.envelope,ciphertext:sealed.output.envelope.ciphertext.slice(0,-2)+(sealed.output.envelope.ciphertext.endsWith('00')?'01':'00')}};
 await assert.rejects(verifyRecipientEnvelope(changed,review,context));
});
test('private platform storage and hosted checkpoints contain no plaintext, while judges remain bound to encrypted result hash',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(readFileSync('apps/object-store/platform-schema.sql','utf8'));
 const env:Env={DELIVERY_REVIEW_KEY:bytesToHex(reviewer),DB:{prepare(sql){let args:SQLInputValue[]=[];return{bind(...v){args=v as SQLInputValue[];return this;},async first<T>(){return(db.prepare(sql).get(...args)??null) as T|null;},async run(){return db.prepare(sql).run(...args);}};}}};
 try{
  const spec=validateTaskSpec({...JSON.parse(readFileSync('tests/fixtures/task-spec.json','utf8')),delivery,verification:{profile:'jev.quorum',profileVersion:'1.0.0',criteria:['deliver'],unverifiableAction:'reject'}});
  const result={...JSON.parse(readFileSync('tests/fixtures/result-manifest.json','utf8')),specHash:hashJson(spec),output:{summary:'PRIVATE_DB_SENTINEL'}} as ResultManifest;
  const protectedResult=await protectResult(env,spec,result);
  assert(!JSON.stringify(db.prepare('SELECT * FROM platform_private_reviews').all()).includes('PRIVATE_DB_SENTINEL'));
  assert(!JSON.stringify(protectedResult).includes('PRIVATE_DB_SENTINEL'));
  const opening=await reviewOpening(env,protectedResult);assert.deepEqual(opening!.output,result.output);
  const payload={spec,result:protectedResult,taskId:result.taskId,attempt:result.attempt,specHash:result.specHash as `0x${string}`,resultHash:hashJson(protectedResult),privateOpening:opening!};
  validateBinding(payload,Number(spec.settlementChainId),spec.taskManager as `0x${string}`);assert.deepEqual(judgeOutput(payload),result.output);
  assert.throws(()=>validateBinding({...payload,privateOpening:{...opening!,output:'tampered'}},Number(spec.settlementChainId),spec.taskManager as `0x${string}`),/COMMITMENT/);
  const checkpoint=await sealCheckpoint(env,result,'run-a');assert(!JSON.stringify(checkpoint).includes('PRIVATE_DB_SENTINEL'));
  assert.deepEqual(await openCheckpoint(env,checkpoint,'run-a'),result);await assert.rejects(openCheckpoint(env,checkpoint,'run-b'));
  const evidence=publicPrivateEvidence({verdict:'reject',checks:[{name:'quality',passed:false,detail:'PRIVATE_DB_SENTINEL'}]},true);
  assert(!JSON.stringify(evidence).includes('PRIVATE_DB_SENTINEL'));assert.doesNotThrow(()=>hashJson(evidence));
 }finally{db.close();}
});
