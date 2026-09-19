import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  canonicalJson, hashJson, parseJsonStrict, parseJsonBytes, parseTaskSpec,
  validateTaskSpec, validateResultManifest, validateCreationWindow, assertSubmissionBinding,
  capabilityId, hashCreateParams, toCreateTaskParams, clientRequestId, assertTaskSpecBinding, LIMITS, UINT128_MAX,
} from '../src/index.js';

const load = (name: string) => readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), 'utf8');
const task = () => parseTaskSpec(load('task-spec.json'));
const result = () => JSON.parse(load('result-manifest.json'));
const vectors = JSON.parse(load('vectors.json'));

test('JCS: ordering, escaping, numbers and Unicode are stable', () => {
  assert.equal(canonicalJson({ z: -0, a: [4.50, 2e-3, true, null], '中': 'é\n' }), '{"a":[4.5,0.002,true,null],"z":0,"中":"é\\n"}');
  assert.equal(canonicalJson({ '\uE000': 1, '😀': 2 }), '{"😀":2,"":1}');
  assert.equal(hashJson({ b: 2, a: 1 }), hashJson({ a: 1, b: 2 }));
  assert.notEqual(hashJson({ a: 'é' }), hashJson({ a: 'e\u0301' }));
});

test('wire JSON rejects duplicate keys including escaped-equivalent names', () => {
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":2}}']) {
    assert.throws(() => parseJsonStrict(text), /DUPLICATE_JSON_KEY/);
  }
  const parsed = parseJsonStrict('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('wire JSON rejects malformed grammar, encoding and dangerous numbers', () => {
  for (const text of ['[1,]', '{"x":1,}', '01', 'true false', '\u00a0{}', '"\\ud800"', '1e999', '9007199254740993', '{"x" 1}', '[']) {
    assert.throws(() => parseJsonStrict(text), Error, text);
  }
  assert.throws(() => parseJsonBytes(new Uint8Array([0xc3, 0x28])));
  assert.throws(() => parseJsonStrict('['.repeat(66) + '0' + ']'.repeat(66)), /JSON_TOO_DEEP/);
  assert.throws(() => parseJsonStrict(' '.repeat(LIMITS.maxJsonBytes + 1)), /JSON_TOO_LARGE/);
});

test('objects cannot hide data behind getters, toJSON, cycles or sparse arrays', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  let invoked = false;
  for (const value of [undefined, { a: undefined }, NaN, Infinity, 1n, new Date(), cycle, Array(2), { get secret() { invoked = true; return 1; } }, { toJSON() { return 'hidden'; } }]) {
    assert.throws(() => canonicalJson(value));
  }
  assert.equal(invoked, false);
});

test('frozen task/result/hash fixtures remain compatible', () => {
  const spec = task(); const submission = validateResultManifest(result());
  assert.equal(canonicalJson(spec), vectors.taskCanonical);
  assert.equal(hashJson(spec), vectors.specHash);
  assert.equal(hashJson(submission), vectors.resultHash);
  assert.equal(capabilityId(spec.capability, spec.capabilityVersion), vectors.capabilityId);
  assert.equal(hashCreateParams(vectors.operator, toCreateTaskParams(spec, vectors.specURI)), vectors.paramsHash);
  assert.equal(submission.specHash, vectors.specHash);
  assert.notEqual(capabilityId(spec.capability, '2.0.0'), vectors.capabilityId);
});

test('schema refuses unknown fields, ambiguous amounts, invalid versions and overflow', () => {
  assert.throws(() => validateTaskSpec({ ...task(), hidden: 'field' }), /INVALID_TASK_SPEC/);
  for (const amountBaseUnits of ['0', '01', '-1', '0.1', '1e6', (UINT128_MAX + 1n).toString(), 5]) {
    const spec = task();
    assert.throws(() => validateTaskSpec({ ...spec, reward: { ...spec.reward, amountBaseUnits } }));
  }
  const upper = task(); upper.taskManager = upper.taskManager.toUpperCase();
  assert.throws(() => validateTaskSpec(upper));
  assert.throws(() => validateTaskSpec({ ...task(), protocol: 'agent-task/0.2' }));
  assert.throws(() => validateTaskSpec({ ...task(), outputSchema: { type: 'not-a-type' } }));
});

test('session must extend strictly beyond execution plus complete review window', () => {
  const spec = task(); const deadline = spec.execution.taskDeadline;
  validateCreationWindow(spec, deadline - 1000, deadline + 301);
  assert.throws(() => validateCreationWindow(spec, deadline - 1000, deadline + 300), /SESSION_TOO_SHORT/);
  assert.throws(() => validateCreationWindow(spec, deadline), /INVALID_TASK_DEADLINE/);
  assert.throws(() => validateCreationWindow(spec, deadline - 10), /INVALID_LEASE/);
  assert.throws(() => validateCreationWindow(spec, deadline - 86401), /INVALID_TASK_DEADLINE/);
});

test('result cannot masquerade as another task, chain, worker or attempt', () => {
  const submission = validateResultManifest(result());
  const expected = { settlementChainId: submission.settlementChainId, taskManager: submission.taskManager, taskId: submission.taskId, attempt: submission.attempt, worker: submission.worker, specHash: submission.specHash };
  assertSubmissionBinding(submission, expected);
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    assert.throws(() => assertSubmissionBinding(submission, { ...expected, [key]: 'different' }), /BINDING_MISMATCH/);
  }
});

test('artifact limits and block provenance are validated', () => {
  const submission = result();
  submission.artifacts = [1, 2].map(() => ({ uri: 'https://example.test/a', hash: vectors.specHash, mediaType: 'application/json', sizeBytes: 3 * 1024 * 1024 }));
  assert.throws(() => validateResultManifest(submission), /ARTIFACTS_TOO_LARGE/);
  submission.artifacts = [];
  submission.provenance.blockRange.fromBlock = '121';
  assert.throws(() => validateResultManifest(submission), /INVALID_BLOCK_RANGE/);
  submission.provenance.blockRange.fromBlock = '100';
  delete submission.provenance.sourceChainId;
  assert.throws(() => validateResultManifest(submission), /MISSING_SOURCE_CHAIN/);
});

test('request ID is stable and rejects empty / ill-formed keys', () => {
  assert.equal(clientRequestId('run-1/research'), clientRequestId('run-1/research'));
  assert.notEqual(clientRequestId('run-1/research'), clientRequestId('run-2/research'));
  for (const key of ['', '\ud800', 'a'.repeat(257)]) assert.throws(() => clientRequestId(key));
});

test('offchain requirements must match onchain economics and network identity', () => {
  const spec = task();
  const expected = { settlementChainId: spec.settlementChainId, taskManager: spec.taskManager,
    requester: spec.requester, clientRequestId: spec.clientRequestId,
    settlementToken: spec.reward.token, params: toCreateTaskParams(spec, vectors.specURI) };
  assertTaskSpecBinding(spec, expected);
  assert.throws(() => assertTaskSpecBinding(spec, { ...expected, settlementChainId: '143' }), /TASK_BINDING_MISMATCH/);
  assert.throws(() => assertTaskSpecBinding(spec, { ...expected, settlementToken: expected.requester }), /TASK_BINDING_MISMATCH/);
  assert.throws(() => assertTaskSpecBinding(spec, { ...expected, params: { ...expected.params, rewardAmount: 1n } }), /TASK_BINDING_MISMATCH/);
  assert.throws(() => assertTaskSpecBinding(spec, { ...expected, params: { ...expected.params, reviewWindowSeconds: 60 } }), /TASK_BINDING_MISMATCH/);
});
