import assert from 'node:assert/strict';
import { test } from 'node:test';
import handler, { type ObjectBucket } from '../apps/object-store/src/index.js';
import { canonicalBytes, hashJson } from '@agent-task/protocol/json';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { Env } from '../apps/object-store/src/index.js';

test('edge object storage authenticates, persists canonical bytes and refuses mutation or oversized bodies', async () => {
  const objects = new Map<string, Uint8Array>(); let writes = 0;
  const bucket: ObjectBucket = {
    async head(key) { return objects.has(key) ? {} : null; },
    async get(key) { const bytes = objects.get(key); return bytes ? { body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } : null; },
    async put(key, bytes) { writes++; objects.set(key, bytes.slice()); },
  };
  const env = { OBJECTS: bucket, STORAGE_UPLOAD_TOKEN: 'edge-test-only-token' }; const value = { hello: 'world' }; const hash = hashJson(value);
  const url = `https://objects.example/objects/${hash}`;
  const put = (bytes: Uint8Array | string, token?: string) => handler.fetch(new Request(url, { method: 'PUT', body: typeof bytes === 'string' ? bytes : Buffer.from(bytes), headers: token ? { authorization: `Bearer ${token}` } : {} }), env);
  assert.equal((await put(canonicalBytes(value))).status, 401);
  assert.equal((await put(canonicalBytes(value), env.STORAGE_UPLOAD_TOKEN)).status, 201);
  assert.equal((await put(canonicalBytes(value), env.STORAGE_UPLOAD_TOKEN)).status, 201); assert.equal(writes, 1);
  assert.equal((await put('{"different":true}', env.STORAGE_UPLOAD_TOKEN)).status, 400);
  assert.equal((await put('x'.repeat(300000), env.STORAGE_UPLOAD_TOKEN)).status, 400);
  const response = await handler.fetch(new Request(url), env); assert.equal(response.status, 200); assert.deepEqual(await response.json(), value);
  assert.equal((await handler.fetch(new Request(url, { method: 'DELETE' }), env)).status, 405);
  assert.equal((await handler.fetch(new Request(`https://objects.example/objects/0x${'0'.repeat(64)}`), env)).status, 404);
});

test('public dashboard persists snapshots, blocks writes and excludes private config fields', async () => {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync('apps/object-store/schema.sql', 'utf8'));
  const env: Env = { STORAGE_UPLOAD_TOKEN: 'dashboard-test-token', DB: { prepare(sql) {
    let values: SQLInputValue[] = [];
    return { bind(...args) { values = args as SQLInputValue[]; return this; }, async first<T>() { return (db.prepare(sql).get(...values) ?? null) as T | null; }, async run() { return db.prepare(sql).run(...values); } };
  } }, ASSETS: { async fetch() { return new Response('<html>Explorer</html>'); } } };
  const payload = { schema: 'worknet-dashboard/1', config: { mode: 'testnet', chainId: 10143 }, tasks: [{ taskId: '1' }], details: { '1': { taskId: '1', status: 3 } }, budget: { remaining: '1500000' } };
  const put = (body: unknown, authenticated = true) => handler.fetch(new Request('https://objects.example/dashboard', { method: 'PUT', body: JSON.stringify(body), headers: authenticated ? { authorization: `Bearer ${env.STORAGE_UPLOAD_TOKEN}` } : {} }), env);
  try {
    assert.equal((await put(payload, false)).status, 401);
    assert.equal((await put(payload)).status, 200);
    const config = await (await handler.fetch(new Request('https://objects.example/api/config'), env)).json();
    assert.equal(config.readOnlyApi, true); assert.equal(typeof config.snapshotAt, 'number');
    assert.equal((await handler.fetch(new Request('https://objects.example/api/hire', { method: 'POST' }), env)).status, 405);
    assert.equal((await put({ ...payload, config: { ...payload.config, rpcUrl: 'https://private.example/key' } })).status, 400);
    assert.equal((await (await handler.fetch(new Request('https://objects.example/api/tasks/1'), env)).json()).status, 3);
    assert.match(await (await handler.fetch(new Request('https://objects.example/'), env)).text(), /Explorer/);
  } finally { db.close(); }
});

test('workspace cookies protect commands, reject CSRF and preserve idempotent queue delivery', async () => {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync('apps/object-store/schema.sql', 'utf8'));
  const env: Env = { WORKSPACE_ACCESS_CODE: 'workspace-test-code-32-characters', STORAGE_UPLOAD_TOKEN: 'bridge-test-token-32-characters', DB: { prepare(sql) { let values: SQLInputValue[] = []; return { bind(...args) { values = args as SQLInputValue[]; return this; }, async first<T>() { return (db.prepare(sql).get(...values) ?? null) as T | null; }, async run() { return db.prepare(sql).run(...values); } }; } } };
  const base = 'https://worknet.example'; let cookie = '';
  const call = (route: string, data?: unknown, opts: { bridge?: boolean; origin?: string; noCookie?: boolean } = {}) => handler.fetch(new Request(base + route, { method: data === undefined ? 'GET' : opts.bridge ? 'PUT' : 'POST', headers: { 'content-type': 'application/json', origin: opts.origin ?? base, ...(cookie && !opts.noCookie ? { cookie } : {}), ...(opts.bridge ? { authorization: `Bearer ${env.STORAGE_UPLOAD_TOKEN}` } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), env);
  try {
    assert.equal((await call('/workspace/state')).status, 401);
    assert.equal((await call('/workspace/session', { code: 'wrong' })).status, 401);
    assert.equal((await call('/workspace/session', { code: env.WORKSPACE_ACCESS_CODE }, { origin: 'https://evil.example' })).status, 403);
    const login = await call('/workspace/session', { code: env.WORKSPACE_ACCESS_CODE }); assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/); assert.match(login.headers.get('set-cookie')!, /Secure/);
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await (await call('/workspace/session')).json()).authenticated, true);
    const state = { goals: [], workers: [], config: { chainId: 10143 } };
    assert.equal((await call('/bridge/workspace', state)).status, 401);
    assert.equal((await call('/bridge/workspace', state, { bridge: true })).status, 200);
    const read = await call('/workspace/state'); assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
    const command = { id: crypto.randomUUID(), type: 'plan', input: { goal: '研究指定公开资料并形成可复核的简报', kind: 'research', sourceUrls: [] } };
    assert.equal((await call('/workspace/commands', command, { noCookie: true })).status, 401);
    assert.equal((await call('/workspace/commands', command, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('/workspace/commands', { ...command, type: 'send-arbitrary-transaction' })).status, 400);
    assert.equal((await call('/workspace/commands', command)).status, 202);
    assert.equal((await call('/workspace/commands', command)).status, 200);
    assert.equal((await call('/workspace/commands', { ...command, input: { ...command.input, goal: '改变同一请求的目标是不允许的行为' } })).status, 409);
    assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_commands').get()!.n, 1);
    assert.equal((await (await call('/bridge/commands', undefined, { bridge: true })).json()).command.id, command.id);
    await call(`/bridge/commands/${command.id}`, { status: 'complete', result: { id: command.id } }, { bridge: true });
    assert.equal((await (await call(`/workspace/commands/${command.id}`)).json()).status, 'complete');
    assert.equal((await (await call('/bridge/commands', undefined, { bridge: true })).json()).command, null);
    const goodCookie = cookie; cookie += 'tamper'; assert.equal((await call('/workspace/state')).status, 401); cookie = goodCookie;
    db.prepare('UPDATE workspace_state SET updated_at = 0').run();
    assert.equal((await (await call('/workspace/state')).json()).connected, false);
    assert.equal((await call('/workspace/commands', { ...command, id: crypto.randomUUID() })).status, 503);
  } finally { db.close(); }
});
