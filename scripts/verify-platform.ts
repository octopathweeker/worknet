import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { requesterVaultAbi } from '@agent-task/contracts';
import { type Address, type Hex } from 'viem';
import { client } from './testnet-common.js';
import { privateJson, persistPrivate, JournalWallet } from './platform-chain.js';

const keys = JSON.parse(await readFile('.runtime/platform/accounts.private.json', 'utf8')) as Record<string, Hex>;
const config = JSON.parse(await readFile('.runtime/platform/config.json', 'utf8'));
const base: string = config.storageUrl;
const state = await privateJson<Record<string, any>>('r3-verification.private.json', () => ({ users: {}, checks: {} }));
const save = () => persistPrivate('r3-verification.private.json', state);
const finalRetest = process.argv.includes('--final-retest');
const groundedRetest = finalRetest || process.argv.includes('--grounded-retest');
if (groundedRetest || process.argv.includes('--retest')) {
  state.initialResearch ??= structuredClone(state.research);
  const key = finalRetest ? 'researchFinal' : groundedRetest ? 'researchGrounded' : 'researchRetest';
  state[key] ??= { planId: crypto.randomUUID(), launchId: crypto.randomUUID() };
  state.research = state[key]; await save();
}
type User = { address: Address; cookie: string; call(route: string, body?: unknown): Promise<any>; raw(route: string, body?: unknown): Promise<Response> };
async function login(name: string): Promise<User> {
  const account = privateKeyToAccount(keys[name]!); let cookie = '';
  const raw = (route: string, body?: unknown) => fetch(`${base}/platform/${route}`, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { 'content-type': 'application/json', origin: base, cookie } });
  const call = async (route: string, body?: unknown) => { const response = await raw(route, body); const data = await response.json() as any; if (!response.ok) throw new Error(`${route}: ${response.status} ${JSON.stringify(data)}`); return data; };
  const challenge = await call('auth/challenge', { address: account.address });
  const response = await raw('auth/verify', { id: challenge.id, signature: await account.signMessage({ message: challenge.message }) }); assert.equal(response.status, 200);
  cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  return { address: account.address, cookie, call, raw };
}
async function waitCommand(user: User, id: string) {
  for (let i = 0; i < 80; i++) { const result = await user.call(`commands/${id}`); if (result.status === 'complete') return result.result; if (result.status === 'failed') throw new Error(JSON.stringify(result)); await new Promise(r => setTimeout(r, 2000)); }
  throw new Error(`COMMAND_TIMEOUT: ${id}; retry same script/state`);
}
const alice = await login('alice'); const bob = await login('bob');
async function auditCommitment(user: User) {
  const account = await user.call('account'); let expected = 0n;
  for (const goal of (await user.call('goals')).goals) {
    if (!goal.taskId) continue;
    const authority = await client.readContract({ address: account.vault, abi: requesterVaultAbi, functionName: 'getTaskAuthority', args: [BigInt(goal.taskId)] });
    if (authority.epoch.toString() === account.budget.epoch && authority.operator.toLowerCase() === config.addresses.operator.toLowerCase()) expected += BigInt(goal.input.reward);
  }
  assert.equal(account.budget.committed, expected.toString()); return account;
}
for (const [name, user] of [['alice', alice], ['bob', bob]] as const) {
  state.users[name] ??= { setupId: crypto.randomUUID(), planId: crypto.randomUUID(), launchId: crypto.randomUUID() }; await save();
  const record = state.users[name];
  if (!record.setupComplete) {
    const setup = await user.call('setup', { id: record.setupId, amount: '300000' });
    if (name === 'alice') {
      const account = privateKeyToAccount(keys.alice!); const signature = await account.signTypedData(setup.typedData);
      await user.call('setup/sponsor', { id: setup.id, signature }); const done = await waitCommand(user, setup.id); record.setupTx = done.transactionHash;
    } else {
      const owner = new JournalWallet(keys.bob!, 'bob');
      if (await client.getBalance({ address: owner.account.address }) < 200000000000000000n) {
        const text = await readFile('.runtime/testnet-accounts/deployer.env', 'utf8'); const key = /^DEPLOYER_PRIVATE_KEY=(.+)$/m.exec(text)![1]!.trim().replace(/^['"]|['"]$/g, '') as Hex;
        await new JournalWallet(key, 'deployer').send('bob-normal-wallet-gas', { to: owner.account.address, value: 250000000000000000n });
      }
      record.setupTxs = [];
      for (const [i, call] of setup.calls.entries()) { const receipt = await owner.send(`setup:${setup.id}:${i}`, { to: call.target, data: call.callData, value: BigInt(call.value) }); assert.equal(receipt.status, 'success'); record.setupTxs.push(receipt.transactionHash); }
    }
    record.setupComplete = true; await save();
  }
  const budget = await user.call('account'); assert.equal(budget.address, user.address.toLowerCase()); assert.equal(budget.budget.effectiveActive, true);
  record.account = budget;
  const planInput = { id: record.planId, goal: `${name === 'alice' ? '智能账户' : '普通钱包'}用户独立发布：统计最近 100 个确认区块内的测试 USDC 转账，交付可复核结果。`, kind: 'analysis', reward: '50000' };
  await user.call('plans', planInput); await user.call('plans', planInput);
  const payload = { id: record.launchId, goalId: record.planId };
  await user.call('launch', payload); await user.call('launch', payload); record.launchResult = await waitCommand(user, record.launchId); await save();
}
assert.equal((await bob.raw(`commands/${state.users.alice.launchId}`)).status, 404);
assert.equal((await alice.raw('launch', { id: crypto.randomUUID(), goalId: state.users.bob.planId })).status, 404);
assert.equal((await fetch(`${base}/platform/plans`, { method: 'POST', headers: { origin: 'https://evil.example', cookie: alice.cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
state.checks.tenantIsolation = true; state.checks.csrfBlocked = true; await save();
for (let i = 0; i < 120; i++) {
  let completed = 0;
  for (const [name,user] of [['alice',alice],['bob',bob]] as const) {
    const goals = (await user.call('goals')).goals;
    assert(!goals.some((g: any) => g.owner !== user.address.toLowerCase()));
    const goal = goals.find((g: any) => g.id === state.users[name].planId); state.users[name].goal = goal;
    if (goal?.status === 'completed') completed++; else console.log(JSON.stringify({ name, state: goal?.status, chainStatus: goal?.task?.status, error: goal?.error }));
  }
  await save(); if (completed === 2) break; if (i === 119) throw new Error('GOAL_TIMEOUT: inspect saved state; do not replace IDs'); await new Promise(r => setTimeout(r, 3000));
}
for (const [name,user] of [['alice',alice],['bob',bob]] as const) {
  const record = state.users[name]; assert.equal(record.goal.evidence.verdict, 'accept'); assert.equal(record.goal.task.worker.toLowerCase(), config.addresses.worker.toLowerCase());
  record.finalAccount = await auditCommitment(user);
}
state.checks.idempotentCommitment = true; state.checks.distinctVaults = state.users.alice.finalAccount.vault !== state.users.bob.finalAccount.vault; assert(state.checks.distinctVaults); await save();
state.research ??= { planId: crypto.randomUUID(), launchId: crypto.randomUUID() }; await save();
await alice.call('plans', { id: state.research.planId, goal: groundedRetest ? '用中文说明 EIP-7702 让 EOA 获得哪些智能账户能力，重点是批量交易和 gas 代付。只引用一个完整原文事实，不讨论余额和操作码限制，不添加其他结论。' : '用中文解释 EIP-7702 在 Monad 上如何帮助用户批量执行和代付 gas，并说明官方文档列出的账户限制；每项结论附准确来源。', kind: 'research', reward: '50000', sourceUrls: ['https://docs.monad.xyz/developer-essentials/eip-7702.md'] });
await alice.call('launch', { id: state.research.launchId, goalId: state.research.planId }); await waitCommand(alice, state.research.launchId);
for (let i = 0; i < 160; i++) {
  const goal = (await alice.call('goals')).goals.find((g: any) => g.id === state.research.planId); state.research.goal = goal; await save();
  if (goal?.status === 'completed') break;
  if (i === 159 || goal?.status === 'attention' && Number(goal?.task?.status) >= 3) throw new Error('RESEARCH_NOT_VERIFIED: inspect original evidence and IDs');
  if (i % 5 === 0) console.log(JSON.stringify({ research: goal?.status, chainStatus: goal?.task?.status, error: goal?.error }));
  await new Promise(r => setTimeout(r, 3000));
}
assert.equal(state.research.goal.evidence.verdict, 'accept');
assert(state.research.goal.evidence.checks.some((c: any) => c.name === 'semantic-judge' && c.passed));
state.users.alice.finalAccount = await auditCommitment(alice);
state.checks.cloudResearchAndJudge = true; await save();
await mkdir('docs/stages/R3', { recursive: true });
await writeFile('docs/stages/R3/testnet-verification.json', JSON.stringify({ at: new Date().toISOString(), origin: base, chainId: 10143, users: state.users, research: state.research, checks: state.checks, ...(state.initialResearch ? { initialResearch: { taskId: state.initialResearch.goal?.taskId, verdict: 'invalid quotation grounding; retained in testnet-initial-verification.json, marked failed audit in UI' } } : {}), humanWalletExtension: 'pending Human validation; software-wallet integration exercised both EOA and 7702 paths' }, null, 2) + '\n');
console.log('Two independent users completed cloud tasks; evidence saved. No cookie/signature/private key included.');
