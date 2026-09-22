import { hexToBytes, type Hex } from 'viem';
import { canonicalJson, hashJson } from '@agent-task/protocol/json';
import { deliveryContext, deliveryPublicKey, isPrivateOutput, openJson, sealJson, sealOutput, verifiedOpening, verifyRecipientEnvelope, type Opening } from '@agent-task/privacy';
import type { ResultManifest, TaskSpec } from '@agent-task/protocol';
import type { Env } from './index.js';

function reviewKey(env: Env) {
  if (!/^0x[0-9a-f]{64}$/.test(env.DELIVERY_REVIEW_KEY ?? '')) throw new Error('PRIVATE_REVIEW_NOT_CONFIGURED');
  return hexToBytes(env.DELIVERY_REVIEW_KEY as Hex);
}
export function reviewPublicKey(env: Env) {
  if (!env.DELIVERY_REVIEW_KEY) return undefined;
  const key = reviewKey(env); try { return deliveryPublicKey(key); } finally { key.fill(0); }
}
export async function protectResult(env: Env, spec: TaskSpec, result: ResultManifest): Promise<ResultManifest> {
  if (!spec.delivery) return result;
  if (spec.delivery.reviewPublicKey !== reviewPublicKey(env)) throw new Error('PRIVATE_REVIEW_KEY_CHANGED');
  const sealed = await sealOutput(result.output, spec.delivery, deliveryContext(result));
  const protectedResult = { ...result, output: sealed.output };
  const hash = hashJson(protectedResult);
  await env.DB!.prepare('INSERT OR IGNORE INTO platform_private_reviews(result_hash,task_id,attempt,envelope,created_at) VALUES (?,?,?,?,?)').bind(hash,result.taskId,result.attempt,canonicalJson(sealed.review),Date.now()).run();
  return protectedResult;
}
export async function reviewOpening(env: Env, result: ResultManifest): Promise<Opening | undefined> {
  if (!isPrivateOutput(result.output)) return undefined;
  const row = await env.DB!.prepare('SELECT envelope FROM platform_private_reviews WHERE result_hash=?').bind(hashJson(result)).first<{ envelope: string }>();
  if (!row) throw new Error('PRIVATE_REVIEW_UNAVAILABLE');
  const key = reviewKey(env);
  try {
    const opening = await openJson(JSON.parse(row.envelope), key, deliveryContext(result)) as Opening;
    verifiedOpening(result.output, opening); await verifyRecipientEnvelope(result.output,opening,deliveryContext(result)); return opening;
  } finally { key.fill(0); }
}
export async function reviewResult(env: Env, result: ResultManifest, spec?: TaskSpec) {
  if (spec?.delivery && (!isPrivateOutput(result.output) || result.output.envelope.recipient !== spec.delivery.publicKey)) throw new Error('PRIVATE_RESULT_BINDING_MISMATCH');
  const opening = await reviewOpening(env,result);
  return opening ? { ...result, output: opening.output } : result;
}
/** Durable hosted checkpoints must not retain the report in plaintext. */
export async function sealCheckpoint(env: Env, execution: unknown, runId: string) {
  const key = reviewKey(env);
  try { return { privateCheckpoint: await sealJson(execution, deliveryPublicKey(key), `worknet-checkpoint/1:${runId}`) }; }
  finally { key.fill(0); }
}
export async function openCheckpoint(env: Env, checkpoint: any, runId: string) {
  if (!checkpoint?.privateCheckpoint) return checkpoint;
  const key = reviewKey(env);
  try { return await openJson(checkpoint.privateCheckpoint, key, `worknet-checkpoint/1:${runId}`); }
  finally { key.fill(0); }
}
export function publicPrivateEvidence(evidence: any, privateDelivery: boolean) {
  if (!privateDelivery) return evidence;
  return { ...evidence, ...(evidence.checks ? { checks: evidence.checks.map((check: any) => ({ name: check.name, passed: check.passed, detail: check.passed ? '私有交付检查通过。' : '私有交付检查未通过。' })) } : {}), ...(evidence.verdicts ? { verdicts: evidence.verdicts.map(({ signature,judge,completionBps,model }: any) => ({ signature,judge,completionBps,...(model?{model}:{}) })) } : {}) };
}
