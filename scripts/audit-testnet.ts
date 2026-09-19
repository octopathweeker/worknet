import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { erc20Abi, parseAbi } from 'viem';
import { taskManagerAbi } from '@agent-task/contracts';
import { loadConfig, chainClient, getTask, json } from '@agent-task/runtime';

const config = loadConfig('.runtime/testnet/config.json'); assert.equal(config.chainId, 10143);
const client = chainClient(config); const accounts = JSON.parse(await readFile('.runtime/testnet-accounts/addresses.public.json', 'utf8')).addresses;
const happy = JSON.parse(await readFile('docs/stages/M5/testnet-happy-paths.json', 'utf8'));
const faults = JSON.parse(await readFile('docs/stages/M5/testnet-fault-paths.json', 'utf8'));
const research = JSON.parse(await readFile('docs/stages/M5/testnet-research.json', 'utf8'));
assert.equal(happy.completedCases, 10); assert.equal(faults.completedCases, 4); assert.equal(research.passed, true);
for (const c of faults.cases) {
  assert.equal(c.completed, true);
  if (c.after.task.status === 3) assert.equal(c.after.task.worker.toLowerCase(), accounts.transferWorker.toLowerCase());
  if (c.after.task.status === 3) assert.equal(BigInt(c.after.workerUSDC) - BigInt(c.before.workerUSDC), 50000n);
}
const next = await client.readContract({ address: config.manager, abi: parseAbi(['function nextTaskId() view returns (uint256)']), functionName: 'nextTaskId' });
const tasks = []; for (let id = 1n; id < next; id++) { const task = await getTask(client, config, id); assert.ok(task.status >= 3, 'No pending escrow at acceptance'); tasks.push({ taskId: id.toString(), status: task.status, worker: task.worker, attempt: task.attempt, rewardAmount: task.rewardAmount }); }
const escrow = await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'totalEscrowed' }); assert.equal(escrow, 0n);
const balance = (address: `0x${string}`) => client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
const vaultBalance = await balance(config.vault);
const settled = tasks.filter(t => t.status === 3); const rewards = settled.reduce((sum, task) => sum + task.rewardAmount, 0n);
assert.equal(vaultBalance + rewards, 5000000n);
const roleBalances = {} as Record<string, unknown>;
for (const [role, address] of Object.entries(accounts) as Array<[string, `0x${string}`]>) roleBalances[role] = { address, nativeWei: await client.getBalance({ address }), usdc: await balance(address) };
const remote = config.storageUrl;
const r = await fetch(new URL('/api/tasks', remote)); assert.equal(r.status, 200); const published = await r.json() as Array<{ taskId: string; status: number }>;
assert.equal(published.length, tasks.length); for (const task of tasks) assert.equal(published.find(t => t.taskId === task.taskId)?.status, task.status);
assert.equal((await fetch(new URL('/api/hire', remote), { method: 'POST', body: '{}' })).status, 405);
for (const { uri, hash } of [{ uri: research.detail.resultURI, hash: research.detail.resultHash }, { uri: research.detail.specURI, hash: research.detail.specHash }]) {
  const object = await fetch(uri); assert.equal(object.status, 200); const { keccak256 } = await import('viem'); assert.equal(keccak256(new Uint8Array(await object.arrayBuffer())), hash);
}
const report = { checkedAt: new Date().toISOString(), chainId: config.chainId, manager: config.manager, vault: config.vault, passed: true, finalizedBlock: (await client.getBlock({ blockTag: 'finalized' })).number,
  tasks, settledTasks: settled.length, expiredTasks: tasks.filter(t => t.status === 5).length, escrow, depositedUSDC: '5000000', vaultBalance, rewards, roleBalances,
  acceptance: { normal: 10, independentWorkerFaults: 4, liveModelOnchain: 1, excludedInitialHarnessTasks: ['11', '12', '13', '14'] }, publicUrl: remote, publicSnapshotMatchesChain: true, publicMutationStatus: 405, contentHashesMatch: true };
await writeFile('docs/stages/M5/final-testnet-audit.json', json(report) + '\n'); console.log(json({ passed: true, settledTasks: settled.length, expiredTasks: report.expiredTasks, escrow, vaultBalance, rewards }));
