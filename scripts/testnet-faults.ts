import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { erc20Abi, type Hex } from 'viem';
import { taskManagerAbi } from '@agent-task/contracts';
import { loadConfig, checkChain, getTask, scanTasks, State, Signer, Requester, Reviewer, HttpStorage, transferTask, json, type Evidence } from '@agent-task/runtime';
import type { TaskSpec } from '@agent-task/protocol';

// Run with the Requester and both long-running Workers stopped. All waits use
// actual finalized Monad Testnet timestamps; no development RPC methods exist here.
const configPath = process.env.DEMO_CONFIG ?? '.runtime/testnet/config.json';
const config = loadConfig(configPath);
assert.equal(config.chainId, 10143); assert.equal(config.mode, 'testnet'); await checkChain(config);
const accounts = JSON.parse(await readFile('.runtime/testnet-accounts/accounts.private.json', 'utf8')).accounts;
const raw = JSON.parse(await readFile(configPath, 'utf8'));
const directory = '.runtime/testnet/fault-cases-v2'; await mkdir(directory, { recursive: true });
const state = new State('.runtime/testnet/account-1.db');
const signer = new Signer(config, state, accounts.requester.privateKey);
const badState = new State('.runtime/testnet/fault-worker.db');
const bad = new Signer(config, badState, accounts.deployer.privateKey);
const client = signer.client;
const storage = new HttpStorage(config.storageUrl, process.env.STORAGE_UPLOAD_TOKEN);
const requester = new Requester(signer, state, storage);
const reviewer = new Reviewer(requester, undefined, event => console.log(json(event)));
type Case = { name: string; spec: TaskSpec; id?: string; before?: unknown; steps: unknown[]; after?: unknown; events?: Array<any>; evidence?: Evidence[]; completed?: boolean };
const completed: Case[] = [];
async function balances() {
  return { budget: await requester.budget(), escrow: await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'totalEscrowed' }),
    workerUSDC: await client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [accounts.transferWorker.address] }),
    badWorkerUSDC: await client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [bad.account.address] }) };
}
const save = async (c: Case) => writeFile(`${directory}/${c.name}.json`, json(c) + '\n');
async function prepare(name: string, deadlineSeconds = 600, lease = 180, review = 120) {
  let c: Case;
  try { c = JSON.parse(await readFile(`${directory}/${name}.json`, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const spec = transferTask(config, `testnet-acceptance/fault-v2/${name}`, Number((await client.getBlock()).timestamp) + deadlineSeconds, raw.fixture);
    spec.execution.claimLeaseSeconds = lease; spec.execution.reviewWindowSeconds = review;
    c = { name, spec, before: await balances(), steps: [] }; await save(c);
  }
  if (!c.id) { const hired = await requester.hire(c.spec); c.id = hired.taskId.toString(); c.steps.push({ action: 'hire', ...hired }); await save(c); }
  return c;
}
async function record(c: Case, action: string, hash: Hex) {
  const receipt = await client.getTransactionReceipt({ hash }); assert.equal(receipt.status, 'success');
  c.steps.push({ action, hash, blockNumber: receipt.blockNumber, timestamp: (await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp }); await save(c);
}
async function waitUntil(c: Case, timestamp: bigint, label: string) {
  const started = Date.now(); console.log(json({ case: c.name, waitingFor: label, chainTimestamp: timestamp }));
  while ((await client.getBlock({ blockTag: 'finalized' })).timestamp < timestamp) await new Promise(r => setTimeout(r, 2000));
  c.steps.push({ action: `wait:${label}`, elapsedMs: Date.now() - started, observedTimestamp: (await client.getBlock({ blockTag: 'finalized' })).timestamp }); await save(c);
}
async function workerOnce(c: Case) {
  const args = ['--env-file=.runtime/testnet-accounts/transferWorker.env', 'apps/cli/dist/main.js', 'worker', '--once', '--config', configPath, '--db', '.runtime/testnet/transfer-worker.db'];
  // Node --env-file does not override variables already present in the process
  // environment. Strip the harness Requester key before loading the Worker role.
  const env = { ...process.env }; delete env.AGENT_PRIVATE_KEY; delete env.DEPLOYER_PRIVATE_KEY; delete env.REQUESTER_API_TOKEN; delete env.STORAGE_UPLOAD_TOKEN;
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`WORKER_EXIT_${code}`)));
  });
  assert.ok(output.includes(accounts.transferWorker.address), 'Independent Worker must load its own wallet');
  c.steps.push({ action: 'independent-worker-once', output }); await save(c);
}
async function finish(c: Case, expectedStatus: number, expectedAttempt?: bigint) {
  const task = await getTask(client, config, BigInt(c.id!)); assert.equal(task.status, expectedStatus);
  if (expectedStatus === 3) assert.equal(task.worker.toLowerCase(), accounts.transferWorker.address.toLowerCase());
  if (expectedAttempt !== undefined) assert.equal(task.attempt, expectedAttempt);
  await scanTasks(client, config, state);
  const events = state.db.prepare('SELECT data FROM events ORDER BY rowid').all().map(row => JSON.parse(String(row.data))).filter(event => event.args.taskId === c.id);
  c.events = events; c.evidence = state.list<Evidence>(`verification:${config.chainId}:${config.manager}:${c.id}:`).map(row => row.value);
  c.after = { task, ...await balances() };
  for (const hash of new Set<Hex>(events.map(e => e.transactionHash))) assert.equal((await client.getTransactionReceipt({ hash })).status, 'success');
  c.completed = true; await save(c); completed.push(c);
  await writeFile('docs/stages/M5/testnet-fault-paths.json', json({ chainId: config.chainId, manager: config.manager, checkedAt: new Date().toISOString(), clock: 'real finalized block timestamps; no time travel', cases: completed }) + '\n');
  console.log(json({ case: c.name, taskId: c.id, status: task.status, attempt: task.attempt, passed: true }));
}
try {
  const invalid = await prepare('invalid-schema'); const id = BigInt(invalid.id!);
  let task = await getTask(client, config, id);
  if (task.status === 0 && task.attempt === 0n) await record(invalid, 'bad-worker-claim', await bad.write(config.manager, taskManagerAbi, 'claimTask', [id], `fault-claim:${id}`));
  task = await getTask(client, config, id);
  if (task.status === 1 && task.attempt === 1n) {
    const result = await storage.put({ protocol: 'agent-task/0.1', settlementChainId: '10143', taskManager: config.manager.toLowerCase(), taskId: id.toString(), attempt: '1', worker: bad.account.address.toLowerCase(), specHash: task.specHash, output: { eventCount: 2, totalAmountBaseUnits: 'wrong' }, artifacts: [], provenance: {} });
    await record(invalid, 'bad-worker-submit', await bad.write(config.manager, taskManagerAbi, 'submitResult', [id, 1n, result.hash, result.uri], `fault-submit:${id}`));
  }
  if ((await getTask(client, config, id)).status === 2 && (await getTask(client, config, id)).attempt === 1n) await reviewer.tick();
  if ((await getTask(client, config, id)).status === 0) await workerOnce(invalid);
  if ((await getTask(client, config, id)).status === 2) await reviewer.tick();
  await finish(invalid, 3, 2n);
  assert.ok(invalid.evidence!.some(e => e.verdict === 'reject')); assert.ok(invalid.evidence!.some(e => e.verdict === 'accept'));

  const expiry = await prepare('no-worker-expiry', 30, 10); const eid = BigInt(expiry.id!);
  if ((await getTask(client, config, eid)).status === 0) { await waitUntil(expiry, BigInt(expiry.spec.execution.taskDeadline), 'task-deadline'); await record(expiry, 'permissionless-expire', await bad.write(config.manager, taskManagerAbi, 'expireTask', [eid], `fault-expire:${eid}`)); }
  await finish(expiry, 5, 0n);
  const beforeExpiry = expiry.before as any; const afterExpiry = expiry.after as any;
  assert.equal(String(afterExpiry.budget.vaultBalance), String(beforeExpiry.budget.vaultBalance));
  assert.equal(BigInt(afterExpiry.budget.committed) - BigInt(beforeExpiry.budget.committed), 50000n);

  const lease = await prepare('lease-recovery', 600, 45); const lid = BigInt(lease.id!);
  task = await getTask(client, config, lid);
  if (task.status === 0 && task.attempt === 0n) await record(lease, 'unresponsive-worker-claim', await bad.write(config.manager, taskManagerAbi, 'claimTask', [lid], `fault-claim:${lid}`));
  task = await getTask(client, config, lid);
  if (task.status === 1 && task.attempt === 1n) { await waitUntil(lease, task.claimLeaseExpiresAt, 'lease-expiry'); await record(lease, 'permissionless-release', await signer.write(config.manager, taskManagerAbi, 'releaseExpiredClaim', [lid], `fault-release:${lid}`)); }
  if ((await getTask(client, config, lid)).status === 0) await workerOnce(lease);
  if ((await getTask(client, config, lid)).status === 2) await reviewer.tick();
  await finish(lease, 3, 2n); assert.ok(lease.events!.some(e => e.eventName === 'ClaimReleased'));

  const offline = await prepare('requester-offline', 600, 180, 60); const oid = BigInt(offline.id!);
  if ((await getTask(client, config, oid)).status === 0) await workerOnce(offline);
  task = await getTask(client, config, oid);
  if (task.status === 2) {
    // Remove the Requester signer lease and database while the Worker waits and
    // finalizes. No Reviewer tick or Requester API is running during this interval.
    await signer.close(); state.close();
    await waitUntil(offline, task.reviewDeadline, 'review-timeout-requester-offline'); await workerOnce(offline);
    // Reopen read-only evidence collection through a separate SQLite connection.
    const inspection = new State('.runtime/testnet/account-1.db');
    await scanTasks(client, config, inspection);
    offline.events = inspection.db.prepare('SELECT data FROM events ORDER BY rowid').all().map(row => JSON.parse(String(row.data))).filter(event => event.args.taskId === offline.id);
    offline.evidence = inspection.list<Evidence>(`verification:${config.chainId}:${config.manager}:${offline.id}:`).map(row => row.value); inspection.close();
    const final = await getTask(client, config, oid); assert.equal(final.status, 3); assert.equal(final.worker.toLowerCase(), accounts.transferWorker.address.toLowerCase());
    assert.ok(offline.events!.some(e => e.eventName === 'TaskSettled' && e.args.reason === 1)); assert.equal(offline.evidence.length, 0);
    offline.after = { task: final, workerUSDC: await client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [accounts.transferWorker.address] }) };
    offline.completed = true; await save(offline); completed.push(offline);
  } else if (task.status === 3 && offline.completed) completed.push(offline);
  else throw new Error('OFFLINE_CASE_UNEXPECTED_STATE');
  await writeFile('docs/stages/M5/testnet-fault-paths.json', json({ chainId: config.chainId, manager: config.manager, checkedAt: new Date().toISOString(), clock: 'real finalized block timestamps; no time travel', completedCases: completed.length, cases: completed }) + '\n');
  console.log(json({ case: offline.name, taskId: offline.id, passed: true, reason: 'REVIEW_TIMEOUT; not verified acceptance' }));
} finally {
  try { await signer.close(); state.close(); } catch { /* Already closed for offline case. */ }
  await bad.close(); badState.close();
}
