import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBudgetAmount } from '../apps/explorer/src/budget-amount.js';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeAbiParameters, keccak256, stringToHex, type Address } from 'viem';
import { platformApi } from '../apps/object-store/src/platform-api.js';
import { makeTask, taskParams, planSchema, researchUrl, type PlatformConfig } from '../apps/object-store/src/platform-domain.js';
import { validateTaskSpec, toCreateTaskParams } from '@agent-task/protocol';
import { hashJson } from '@agent-task/protocol/json';
import { exactPermission, permissionTypedData, redeemPermission } from '@agent-task/accounts';
import type { Env } from '../apps/object-store/src/index.js';
import { sourcePassages, verifyPlatformResult } from '../apps/object-store/src/platform-execution.js';

const alice = privateKeyToAccount(`0x${'11'.repeat(32)}`); const bob = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const config: PlatformConfig = { chainId: 10143, manager: `0x${'33'.repeat(20)}`, factory: `0x${'44'.repeat(20)}`, token: `0x${'55'.repeat(20)}`, operator: `0x${'66'.repeat(20)}`, worker: `0x${'77'.repeat(20)}`, sponsor: `0x${'88'.repeat(20)}`, rpcUrl: 'https://rpc.test', storageUrl: 'https://worknet.test' };

test('platform login is nonce-bound; user data and commands are isolated; CSRF and replay fail', async () => {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync('apps/object-store/platform-schema.sql', 'utf8'));
  const priorFetch = globalThis.fetch; let wakes = 0;
  globalThis.fetch = async (request, options) => {
    assert.equal(String(request), config.rpcUrl + '/');
    const payload = JSON.parse(String(options?.body));
    // The only RPC needed here is the real client's predictVault eth_call.
    assert.equal(payload.method, 'eth_call');
    return Response.json({ jsonrpc: '2.0', id: payload.id, result: encodeAbiParameters([{ type: 'address' }], [`0x${payload.params[0].data.slice(-40)}` as Address]) });
  };
  const env: Env = { PLATFORM_CONFIG: JSON.stringify(config), PLATFORM: { idFromName: () => 'one', get: () => ({ fetch: async () => { wakes++; return new Response('ok'); } }) } as any, DB: { prepare(sql) { let args: SQLInputValue[] = []; return { bind(...values) { args = values as SQLInputValue[]; return this; }, async first<T>() { return (db.prepare(sql).get(...args) ?? null) as T | null; }, async run() { return db.prepare(sql).run(...args); } }; } } };
  const call = (path: string, body?: unknown, cookie = '', origin = config.storageUrl) => platformApi(new Request(`${config.storageUrl}/platform/${path}`, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { 'content-type': 'application/json', origin, cookie } }), env);
  async function login(account: typeof alice) {
    const challenge = await (await call('auth/challenge', { address: account.address })).json() as any;
    const signature = await account.signMessage({ message: challenge.message });
    const response = await call('auth/verify', { id: challenge.id, signature }); assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie')!, /HttpOnly; Secure; SameSite=Strict/);
    assert.equal((await call('auth/verify', { id: challenge.id, signature })).status, 401);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  }
  try {
    assert.equal((await call('goals')).status, 401);
    assert.equal((await call('auth/challenge', { address: alice.address }, '', 'https://evil.test')).status, 403);
    const wrongChallenge = await (await call('auth/challenge', { address: alice.address })).json() as any;
    assert.equal((await call('auth/verify', { id: wrongChallenge.id, signature: await bob.signMessage({ message: wrongChallenge.message }) })).status, 401);
    const a = await login(alice); const b = await login(bob);
    for (const amount of ['10000000', '5000001', '9999', '0.5', 'invalid']) {
      const response = await call('setup', { id: crypto.randomUUID(), amount }, a);
      assert.equal(response.status, 400);
      assert.match((await response.json() as any).error, /0.01–5 test USDC/);
    }
    assert.equal(db.prepare('SELECT count(*) n FROM platform_intents').get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM platform_commands').get()!.n, 0);
    const input = { id: crypto.randomUUID(), goal: '分析最近的测试 USDC 转账并给出复算结果', kind: 'analysis', reward: '50000' };
    assert.equal((await call('plans', input, a)).status, 200);
    assert.equal((await call('plans', input, a)).status, 200);
    assert.equal((await call('plans', { ...input, reward: '60000' }, a)).status, 409);
    assert.equal((await call('plans', input, b)).status, 409);
    assert.equal((await (await call('goals', undefined, b)).json() as any).goals.length, 0);
    assert.equal((await (await call('goals', undefined, a)).json() as any).goals.length, 1);
    const launch = { id: crypto.randomUUID(), goalId: input.id };
    assert.equal((await call('launch', launch, b)).status, 404);
    assert.equal((await call('launch', launch, a)).status, 202);
    assert.equal((await call('launch', launch, a)).status, 202);
    assert.equal((await call(`commands/${launch.id}`, undefined, b)).status, 404);
    assert.equal((await call(`commands/${launch.id}`, undefined, a)).status, 200);
    assert.equal(db.prepare('SELECT count(*) n FROM platform_commands').get()!.n, 1);
    assert.equal(wakes, 2);
    assert.equal((await call('plans', { ...input, id: crypto.randomUUID() }, a, 'https://evil.test')).status, 403);
    assert.equal((await call('logout', {}, a)).status, 200); assert.equal((await call('goals', undefined, a)).status, 401);
    db.prepare('UPDATE platform_sessions SET expires_at=0').run(); assert.equal((await call('goals', undefined, b)).status, 401);
  } finally { globalThis.fetch = priorFetch; db.close(); }
});

test('edge task templates match frozen protocol and reject unsupported source/range/reward', () => {
  for (const kind of ['analysis', 'research'] as const) {
    const input = planSchema.parse({ id: crypto.randomUUID(), goal: '解释并验证 Monad 的公开资料与链上分析结果', kind, reward: '50000' });
    const spec = makeTask({ id: input.id, owner: alice.address, vault: bob.address, input, createdAt: new Date().toISOString(), status: 'draft' }, config, 1900000000, 1000n);
    validateTaskSpec(spec); const params = taskParams(spec, config.storageUrl); assert.deepEqual(params, toCreateTaskParams(spec, params.specURI)); assert.equal(params.specHash, hashJson(spec));
  }
  assert.throws(() => researchUrl('https://docs.monad.xyz.evil.test/private')); assert.throws(() => researchUrl('http://127.0.0.1/')); assert.throws(() => researchUrl('https://docs.monad.xyz/?secret=x'));
  assert.throws(() => planSchema.parse({ id: crypto.randomUUID(), goal: '测试超出授权范围的任务预算', kind: 'analysis', reward: '999999' }));
});

test('7702 exact permissions bind every call, amount, owner, sponsor, deadline and intent', async () => {
  const calls = [{ target: config.factory, value: 0n, callData: '0x12345678' as const }];
  const a = exactPermission(alice.address, config.sponsor, calls, 'intent-1', 1900000000);
  assert.equal(a.caveats.length, 3);
  const signature = await alice.signTypedData(permissionTypedData(a));
  const { recoverTypedDataAddress } = await import('viem'); assert.equal(await recoverTypedDataAddress({ ...permissionTypedData(a), signature }), alice.address);
  const b = exactPermission(alice.address, config.sponsor, [{ ...calls[0]!, value: 1n }], 'intent-1', 1900000000);
  assert.notEqual(hashJson(a), hashJson(b));
  assert.notEqual(redeemPermission({ ...a, signature }, calls).data, redeemPermission({ ...a, signature }, [{ ...calls[0]!, callData: '0x87654321' }]).data);
});

test('research passages preserve complete wrapped sentences and exclude code and list numbering', () => {
  const sentence = 'When the EOA is treated like a smart contract,\nthat code cannot call CREATE or CREATE2.';
  const text = `# Reference\n\n${sentence}\n\n1. A delegated account preserves its existing address.\n2. The following is a separate numbered explanation.\n\n\x60\x60\x60js\nconst secret = "Do not use this code example as evidence.";\n\x60\x60\x60\n`;
  const quotes = sourcePassages(text);
  assert(quotes.includes(sentence)); assert(quotes.every(q => text.includes(q)));
  assert(!quotes.some(q => q.includes('const secret') || /^\d+\.$/.test(q)));
});

test('research keeps source text out of deliverable review and rejects unsupported literal features before model judgment', async () => {
  const url = 'https://docs.monad.xyz/developer-essentials/eip-7702.md';
  const quote = 'EOAs can gain transaction batching and gas sponsorship capabilities.';
  const text = `${quote}\n\nAccount abstraction operates directly on an EOA.\n\nThis source also discusses unrelated balance restrictions.`;
  const previous = globalThis.fetch; globalThis.fetch = async () => new Response(text);
  const calls: any[] = [];
  const env = { PLATFORM_AI_MODEL: 'worker-model', PLATFORM_JUDGE_MODEL: 'independent-judge', AI: { async run(model: string, input: any) {
    calls.push({ model, input: JSON.parse(input.messages[1].content) });
    return { response: JSON.stringify(calls.length === 1 ? { checks: [{ index: 0, supported: true, reason: 'same supported fact' }] } : { accept: true, checks: [{ name: 'task', passed: true, detail: 'task answered' }] }) };
  } } } as unknown as Env;
  const input = planSchema.parse({ id: crypto.randomUUID(), goal: '用中文说明批量交易与 gas 代付能力', kind: 'research', reward: '50000', sourceUrls: [url] });
  const spec = makeTask({ id: input.id, owner: alice.address, vault: bob.address, input, createdAt: new Date().toISOString(), status: 'draft' }, config, 1900000000, 1000n);
  const result = { output: { mode: 'llm', summary: '账户可获得批量交易和 gas 代付能力。', findings: [{ title: '账户能力', claim: '账户可获得批量交易和 gas 代付能力。', quote, sourceUri: url }] }, provenance: { sources: [{ uri: url, contentHash: keccak256(stringToHex(text)) }] } };
  try {
    assert.equal((await verifyPlatformResult(spec, result, config, env)).verdict, 'accept');
    assert.equal(calls.length, 2); assert(calls.every(c => c.model === 'independent-judge'));
    assert.equal(calls[1].input.DELIVERABLE_PROSE.summary, result.output.summary);
    assert.equal(calls[1].input.DELIVERABLE_PROSE.findings[0].quote, undefined);
    assert.equal(calls[1].input.VERIFIED_QUOTATIONS[0].quote, result.output.findings[0]!.quote);
    assert(!JSON.stringify(calls[1].input).includes('unrelated balance restrictions'));
    result.output.findings[0]!.quote = 'Account abstraction operates directly on an EOA.';
    const bad = await verifyPlatformResult(spec, result, config, env); assert.equal(bad.verdict, 'reject');
    assert(bad.checks.some(c => c.name === 'quoted-identifiers' && !c.passed)); assert.equal(calls.length, 2);
  } finally { globalThis.fetch = previous; }
});


test('budget amount uses six decimals and rejects unsupported precision and limits before saving an intent', () => {
  assert.equal(parseBudgetAmount('0.5'), '500000');
  assert.equal(parseBudgetAmount('0.01'), '10000');
  assert.equal(parseBudgetAmount('5'), '5000000');
  assert.equal(parseBudgetAmount('0.123456'), '123456');
  for (const value of ['10', '5.000001', '0.009999', '0.5000001', '1e-1', '-0.5', 'NaN', '']) assert.throws(() => parseBudgetAmount(value), /0.01–5 test USDC/);
});
