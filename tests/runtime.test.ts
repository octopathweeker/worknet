import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { HttpStorage, startStorage, State, checkOutputSchema, retryTransientRead, publicFailure } from '@agent-task/runtime';
import { hashJson } from '@agent-task/protocol';

test('public status and evidence do not expose transport URLs, credential paths or request bodies', () => {
  const error = Object.assign(new Error('HTTP failed at https://rpc.example/v2/private-provider-key; body contains private payload'), { name: 'HttpRequestError' });
  assert.equal(publicFailure(error), 'HttpRequestError');
  assert.equal(publicFailure(new Error('SOURCE_ADDRESS_NOT_PUBLIC')), 'Error: SOURCE_ADDRESS_NOT_PUBLIC');
  assert.equal(publicFailure(Object.assign(new Error('secret'), { name: 'https://rpc.example/private-key' })), 'OperationError');
  assert.equal(publicFailure('private-provider-key'), 'OperationError');
});

test('content store authenticates writes, verifies hash and cannot overwrite content', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-store-'));
  const token = 'test-only-upload-token';
  const server = await startStorage({ directory, token, port: 0 });
  const { port } = server.address() as { port: number }; const base = `http://127.0.0.1:${port}`;
  try {
    const storage = new HttpStorage(base, token); const object = { value: 'evidence' };
    const stored = await storage.put(object);
    assert.equal(stored.hash, hashJson(object)); assert.deepEqual(JSON.parse(JSON.stringify(await storage.get(stored.uri, stored.hash))), object);
    assert.equal((await fetch(stored.uri, { method: 'PUT', body: '{}' })).status, 401);
    assert.equal((await fetch(stored.uri, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: '{"different":true}' })).status, 400);
    assert.equal((await fetch(`${base}/objects/../../secret`)).status, 404);
    assert.equal((await fetch(stored.uri, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ value: 'x'.repeat(300000) }) })).status, 400);
    const missingHash = `0x${'0'.repeat(64)}` as const;
    await assert.rejects(() => storage.get(`${base}/objects/${missingHash}`, missingHash), /Storage download failed: 404/);
    await assert.rejects(() => storage.get('https://example.com/objects/' + stored.hash, stored.hash), /NOT_ALLOWED/);
    assert.deepEqual(JSON.parse(JSON.stringify(await storage.get(stored.uri, stored.hash))), object);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true }); }
});

test('SQLite transaction rollback and reopen retain only committed data', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-state-')); const filename = path.join(directory, 'db');
  try {
    const state = new State(filename); state.set('ok', { amount: 2n });
    assert.throws(() => state.transaction(() => { state.set('bad', true); throw new Error('rollback'); })); state.close();
    const reopened = new State(filename); assert.deepEqual(reopened.get('ok'), { amount: '2' }); assert.equal(reopened.get('bad'), undefined); reopened.close();
  } finally { await rm(directory, { recursive: true }); }
});

test('schema validator is isolated, refuses remote refs, and stops pathological regex', async () => {
  assert.equal((await checkOutputSchema({ type: 'object', required: ['x'], properties: { x: { type: 'integer' } } }, { x: 1 })).passed, true);
  assert.equal((await checkOutputSchema({ $ref: 'https://example.test/schema' }, {})).passed, false);
  const start = Date.now();
  const result = await checkOutputSchema({ type: 'string', pattern: '^(a+)+$' }, 'a'.repeat(200) + '!');
  assert.equal(result.passed, false); assert.ok(Date.now() - start < 5000);
});

test('transient RPC estimation failures retry within bounds; contract reverts do not retry', async () => {
  let calls = 0;
  const gas = await retryTransientRead(async () => { if (++calls < 3) throw { cause: { code: -32603 } }; return 620479n; });
  assert.equal(gas, 620479n); assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(retryTransientRead(async () => { calls++; throw new Error('execution reverted'); }), /execution reverted/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(retryTransientRead(async () => { calls++; throw Object.assign(new Error('rate limited'), { status: 429 }); }), /rate limited/);
  assert.equal(calls, 3);
});
