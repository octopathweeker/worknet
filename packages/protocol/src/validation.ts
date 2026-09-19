import { Ajv } from 'ajv';
import { LIMITS, UINT128_MAX, UINT64_MAX } from './constants.js';
import { canonicalJson, parseJsonStrict } from './json.js';
import { resultManifestSchema, taskSpecSchema, type ResultManifest, type TaskSpec } from './schemas.js';

const ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false });
const taskValidator = ajv.compile<TaskSpec>(taskSpecSchema);
const resultValidator = ajv.compile<ResultManifest>(resultManifestSchema);

function uint(value: string, bits: number): void {
  if (BigInt(value) >= (1n << BigInt(bits))) throw new Error(`UINT${bits}_OVERFLOW`);
}
function uri(value: string): void {
  if (new TextEncoder().encode(value).length > LIMITS.maxUriBytes) throw new Error('URI_TOO_LONG');
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.hash) throw new Error('INVALID_URI');
}

export function validateTaskSpec(value: unknown): TaskSpec {
  canonicalJson(value);
  if (!taskValidator(value)) throw new Error(`INVALID_TASK_SPEC: ${ajv.errorsText(taskValidator.errors)}`);
  uint(value.settlementChainId, 256);
  if (BigInt(value.reward.amountBaseUnits) > UINT128_MAX) throw new Error('UINT128_OVERFLOW');
  if (!ajv.validateSchema(value.outputSchema)) throw new Error('INVALID_OUTPUT_SCHEMA');
  // This stage checks the schema document, not an untrusted result or remote $ref.
  return value;
}

export function validateResultManifest(value: unknown): ResultManifest {
  canonicalJson(value);
  if (!resultValidator(value)) throw new Error(`INVALID_RESULT_MANIFEST: ${ajv.errorsText(resultValidator.errors)}`);
  uint(value.settlementChainId, 256); uint(value.taskId, 256);
  if (BigInt(value.attempt) > UINT64_MAX) throw new Error('UINT64_OVERFLOW');
  if (value.agentRef) { uint(value.agentRef.chainId, 256); uint(value.agentRef.agentId, 256); }
  let total = 0;
  for (const artifact of value.artifacts) { total += artifact.sizeBytes; uri(artifact.uri); }
  if (total > LIMITS.maxArtifactBytes) throw new Error('ARTIFACTS_TOO_LARGE');
  for (const source of value.provenance.sources ?? []) uri(source.uri);
  if (value.provenance.sourceChainId) uint(value.provenance.sourceChainId, 256);
  const range = value.provenance.blockRange;
  if (range) {
    if (!value.provenance.sourceChainId) throw new Error('MISSING_SOURCE_CHAIN');
    uint(range.fromBlock, 256); uint(range.toBlock, 256);
    if (BigInt(range.fromBlock) > BigInt(range.toBlock)) throw new Error('INVALID_BLOCK_RANGE');
  }
  return value;
}

export function parseTaskSpec(text: string): TaskSpec { return validateTaskSpec(parseJsonStrict(text)); }
export function parseResultManifest(text: string): ResultManifest { return validateResultManifest(parseJsonStrict(text)); }

export function validateCreationWindow(spec: TaskSpec, now: number, validUntil?: number): void {
  validateTaskSpec(spec);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('INVALID_TIME');
  const { taskDeadline, claimLeaseSeconds, reviewWindowSeconds } = spec.execution;
  if (taskDeadline <= now || taskDeadline - now > LIMITS.maxTaskLifetimeSeconds) throw new Error('INVALID_TASK_DEADLINE');
  if (claimLeaseSeconds > taskDeadline - now) throw new Error('INVALID_LEASE');
  if (validUntil !== undefined) {
    if (!Number.isSafeInteger(validUntil) || validUntil < 0) throw new Error('INVALID_TIME');
    if (BigInt(taskDeadline) + BigInt(reviewWindowSeconds) >= BigInt(validUntil)) throw new Error('SESSION_TOO_SHORT');
  }
}

/** Cross-network, task and attempt binding must pass before any semantic verification. */
export function assertSubmissionBinding(result: ResultManifest, expected: {
  settlementChainId: string; taskManager: string; taskId: string; attempt: string; worker: string; specHash: string;
}): void {
  validateResultManifest(result);
  for (const key of ['settlementChainId', 'taskManager', 'taskId', 'attempt', 'worker', 'specHash'] as const) {
    if (result[key] !== expected[key]) throw new Error(`SUBMISSION_BINDING_MISMATCH: ${key}`);
  }
}
