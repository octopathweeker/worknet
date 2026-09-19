import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { loadConfig, chainClient, getTask, getCachedTask, scanTasks, State, Signer, HttpStorage, Requester, transferTask, Workspace, Reviewer } from '@agent-task/runtime';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { requesterVaultAbi, taskManagerAbi } from '@agent-task/contracts';
import { mnemonicToAccount } from 'viem/accounts';
import { bytesToHex, erc20Abi, type Hex } from 'viem';
import { toCreateTaskParams, type TaskSpec } from '@agent-task/protocol';

async function port(): Promise<number> { const s = createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const p = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return p; }
function process_(args: string[], env: NodeJS.ProcessEnv): { child: ChildProcess; output: () => string; completed: Promise<string> } {
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { output += chunk; });
  const completed = new Promise<string>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(output))); });
  void completed.catch(() => undefined); return { child, output: () => output, completed };
}
async function waitFor(check: () => Promise<boolean>, limit = 15000) { const until = Date.now() + limit; while (Date.now() < until) { if (await check().catch(() => false)) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('Startup timeout'); }
async function stop(child: ChildProcess) { if (child.exitCode !== null) return; const ended = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM'); await Promise.race([ended, new Promise<void>(r => setTimeout(r, 2000))]); if (child.exitCode === null) child.kill('SIGKILL'); }

test('independent CLI processes hire, recover, execute, verify and settle on local Monad', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-e2e-')); const rpcPort = await port(); const storePort = await port(); const apiPort = await port();
  const configPath = path.join(directory, 'config.json');
  const env = { ...process.env, LOCAL_RPC_URL: `http://127.0.0.1:${rpcPort}`, STORAGE_URL: `http://127.0.0.1:${storePort}`, DEMO_CONFIG: configPath, STORAGE_UPLOAD_TOKEN: 'e2e-only-upload-token', API_PORT: String(apiPort), REQUESTER_API_TOKEN: 'e2e-only-requester-token-32chars', REQUESTER_API_URL: `http://127.0.0.1:${apiPort}` };
  const anvil = spawn(path.resolve(process.env.FOUNDRY_BIN ?? '.tools/foundry', 'anvil'), ['--network', 'monad', '--hardfork', 'MonadNine', '--chain-id', '31337', '--block-time', '1', '--host', '127.0.0.1', '--port', String(rpcPort), '--silent'], { stdio: 'ignore' });
  let storage: ReturnType<typeof process_> | undefined;
  let daemon: ReturnType<typeof process_> | undefined;
  let mcp: Client | undefined;
  const cli = (...args: string[]) => process_(['apps/cli/dist/main.js', ...args, '--config', configPath], env).completed;
  try {
    await waitFor(async () => (await fetch(env.LOCAL_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })).ok);
    await process_(['--import', 'tsx', 'scripts/local-deploy.ts'], env).completed;
    storage = process_(['apps/cli/dist/main.js', 'storage', '--port', String(storePort), '--directory', path.join(directory, 'objects')], env);
    await waitFor(async () => (await fetch(env.STORAGE_URL)).status === 404);
    const first = await cli('demo-task'); assert.match(first, /"taskId":"1"/);
    const retry = await cli('demo-task'); assert.match(retry, /"taskId":"1"/);
    await cli('worker', '--once');
    const config = loadConfig(configPath); const client = chainClient(config);
    assert.equal((await getTask(client, config, 1n)).status, 2);
    await cli('worker', '--once'); // A fresh process must not execute or submit again.
    const review = await cli('reviewer', '--once'); assert.match(review, /rpc-full-recomputation/);
    const settled = await getTask(client, config, 1n); assert.equal(settled.status, 3);
    assert.equal(await client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [settled.worker] }), 50000n);
    assert.equal(await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'totalEscrowed' }), 0n);
    const agent = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 1 });
    const state = new State(path.join(directory, 'account-1.db'));
    const stored = state.list<{ spec: TaskSpec; uri: string }>('request:')[0]!.value;
    // Simulate a crash after the node mined create but before our outbox marked confirmation.
    state.db.prepare("UPDATE transactions SET status='signed' WHERE id LIKE '%:create:%'").run();
    const signer = new Signer(config, state, bytesToHex(agent.getHdKey().privateKey!));
    await signer.write(config.vault, requesterVaultAbi, 'createTask', [stored.spec.clientRequestId, toCreateTaskParams(stored.spec, stored.uri)], `create:${stored.spec.clientRequestId}`);
    const budget = await new Requester(signer, state, new HttpStorage(config.storageUrl, env.STORAGE_UPLOAD_TOKEN)).budget();
    assert.equal(budget.committed, 50000n); assert.equal(budget.vaultBalance, 49_950_000n);
    await signer.close(); state.close();
    daemon = process_(['apps/daemon/dist/main.js'], env);
    await waitFor(async () => (await fetch(`${env.REQUESTER_API_URL}/api/health`)).ok);
    assert.equal((await fetch(`${env.REQUESTER_API_URL}/api/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"taskId":"1"}' })).status, 401);
    assert.equal((await fetch(`${env.REQUESTER_API_URL}/api/tasks`, { headers: { Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await fetch(`${env.REQUESTER_API_URL}/api/accept`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.REQUESTER_API_TOKEN}` }, body: JSON.stringify({ taskId: '1', attempt: '999', resultHash: settled.resultHash }) })).status, 400);
    mcp = new Client({ name: 'e2e-requester', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['apps/mcp/dist/main.js'], env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)), stderr: 'pipe' });
    await mcp.connect(transport);
    const tools = await mcp.listTools(); assert.equal(tools.tools.length, 8); assert.equal(tools.tools.some(t => /transfer_token|execute_calldata|sign_message/.test(t.name)), false);
    const budgetTool = await mcp.callTool({ name: 'get_budget', arguments: {} }); assert.equal(budgetTool.isError, false);
    const raw = JSON.parse(await readFile(configPath, 'utf8'));
    const spec = transferTask(config, 'e2e/reject-and-recover', Number((await client.getBlock()).timestamp) + 900, raw.fixture);
    const hired = await mcp.callTool({ name: 'hire_agent', arguments: { spec } }); assert.equal(hired.isError, false);
    const id = 2n; const pending = await getTask(client, config, id);
    const badAccount = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 4 });
    const badState = new State(path.join(directory, 'bad-worker.db')); const bad = new Signer(config, badState, bytesToHex(badAccount.getHdKey().privateKey!));
    await bad.write(config.manager, taskManagerAbi, 'claimTask', [id]);
    const badResult = await new HttpStorage(config.storageUrl, env.STORAGE_UPLOAD_TOKEN).put({ protocol: 'agent-task/0.1', settlementChainId: '31337', taskManager: config.manager.toLowerCase(), taskId: '2', attempt: '1', worker: bad.account.address.toLowerCase(), specHash: pending.specHash, output: { eventCount: 2, totalAmountBaseUnits: 'wrong' }, artifacts: [], provenance: {} });
    await bad.write(config.manager, taskManagerAbi, 'submitResult', [id, 1n, badResult.hash, badResult.uri]); await bad.close(); badState.close();
    await waitFor(async () => (await getTask(client, config, id)).status === 0);
    await cli('worker', '--once');
    await waitFor(async () => (await getTask(client, config, id)).status === 3);
    const detail = await (await fetch(`${env.REQUESTER_API_URL}/api/tasks/2`)).json();
    assert.equal(detail.attempt, '2'); assert.equal(detail.verification.length, 2);
    assert.ok(detail.events.some((e: { eventName: string }) => e.eventName === 'ResultRejected'));
    assert.ok(detail.verification.some((v: { verdict: string }) => v.verdict === 'reject'));
    assert.ok(detail.verification.some((v: { verdict: string }) => v.verdict === 'accept'));
    await mcp.close(); mcp = undefined; await stop(daemon.child); daemon = undefined;
    await cli('demo-task', '--key', 'e2e/offline-requester'); await cli('worker', '--once');
    assert.equal((await getTask(client, config, 3n)).status, 2);
    for (const [method, params] of [['evm_increaseTime', [301]], ['evm_mine', []]] as const) {
      const response = await fetch(env.LOCAL_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      assert.equal((await response.json()).error, undefined);
    }
    await cli('worker', '--once'); assert.equal((await getTask(client, config, 3n)).status, 3);
    const settlements = await client.getContractEvents({ address: config.manager, abi: taskManagerAbi, eventName: 'TaskSettled', args: { taskId: 3n }, fromBlock: BigInt(config.deploymentBlock) });
    assert.equal(settlements[0]!.args.reason, 1);
    // Reauthorizing the same EOA must not let one old-epoch submission stall
    // the reviewer before it reaches newly authorized work.
    await cli('demo-task', '--key', 'e2e/old-epoch'); await cli('worker', '--once');
    assert.equal((await getTask(client, config, 4n)).status, 2);
    const ownerAccount = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 0 });
    const ownerState = new State(path.join(directory, 'owner.db'));
    const ownerSigner = new Signer(config, ownerState, bytesToHex(ownerAccount.getHdKey().privateKey!));
    try {
      const now = (await client.getBlock()).timestamp;
      await ownerSigner.write(config.vault, requesterVaultAbi, 'authorizeAgent', [agent.address, { validAfter: now, validUntil: now + 86400n, maxPerTask: 2_000_000n, maxTotalCommitment: 10_000_000n }]);
      await cli('demo-task', '--key', 'e2e/new-epoch'); await cli('worker', '--once');
      daemon = process_(['apps/daemon/dist/main.js'], env);
      await waitFor(async () => (await getTask(client, config, 5n)).status === 3);
      const old = await getTask(client, config, 4n);
      assert.equal(old.status, 2); // No unauthorized action on the old commitment.
      await ownerSigner.write(config.vault, requesterVaultAbi, 'acceptResult', [4n, old.attempt, old.resultHash]);
      assert.equal((await getTask(client, config, 4n)).status, 3);
    } finally { await ownerSigner.close(); ownerState.close(); }
    await stop(daemon.child); daemon = undefined;
    const indexFile = path.join(directory, 'index-recovery.db');
    let index = new State(indexFile);
    try {
      assert.deepEqual(await scanTasks(client, config, index), [1n, 2n, 3n, 4n, 5n]);
      const expectedLogs = await client.getLogs({ address: config.manager, fromBlock: BigInt(config.deploymentBlock), toBlock: await client.getBlockNumber() });
      assert.equal(index.db.prepare('SELECT count(*) AS n FROM events').get()!.n, expectedLogs.length);
      let contractReads = 0;
      const counted = new Proxy(client, { get(target, key) { if (key === 'readContract') return (...args: unknown[]) => { contractReads++; return Reflect.apply(target.readContract, target, args); }; return Reflect.get(target, key); } });
      const terminal = await getCachedTask(counted, config, index, 5n);
      assert.deepEqual(await getCachedTask(counted, config, index, 5n), terminal);
      assert.equal(contractReads, 1); assert.equal(typeof terminal.attempt, 'bigint');
      // Restart after losing the cursor, while retaining previously indexed rows.
      index.db.prepare("DELETE FROM kv WHERE key LIKE 'cursor:%' OR key LIKE 'known:%'").run();
      index.close(); index = new State(indexFile);
      assert.deepEqual(await scanTasks(client, config, index), [1n, 2n, 3n, 4n, 5n]);
      assert.equal(index.db.prepare('SELECT count(*) AS n FROM events').get()!.n, expectedLogs.length);
      const cursorKey = `cursor:${config.chainId}:${config.manager.toLowerCase()}`;
      const cursor = index.get<{ next: string; blockHash: Hex }>(cursorKey)!;
      index.set(cursorKey, { ...cursor, blockHash: `0x${'0'.repeat(64)}` });
      await assert.rejects(scanTasks(client, config, index), /CHAIN_HISTORY_CHANGED/);
      assert.equal(index.get<{ next: string }>(cursorKey)!.next, cursor.next);
    } finally { index.close(); }
    const workspaceState = new State(path.join(directory, 'account-1.db'));
    const workspaceSigner = new Signer(config, workspaceState, bytesToHex(agent.getHdKey().privateKey!));
    try {
      const requester = new Requester(workspaceSigner, workspaceState, new HttpStorage(config.storageUrl, env.STORAGE_UPLOAD_TOKEN));
      const workspace = new Workspace(requester, configPath, false);
      const workerAddress = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 2 }).address;
      const goalId = crypto.randomUUID();
      const command = { id: goalId, type: 'plan', input: { goal: '统计指定区块的转账记录并交付可复核的分析结果', kind: 'analysis', sourceUrls: [], fromBlock: raw.fixture.fromBlock, toBlock: raw.fixture.toBlock } };
      const plan = await workspace.run(command) as { id: string }; assert.equal(plan.id, goalId);
      assert.deepEqual(await workspace.run(command), plan);
      await assert.rejects(workspace.run({ ...command, input: { ...command.input, goal: '不允许同一请求编号改变为其他目标' } }), /同一操作编号/);
      await workspace.run({ id: crypto.randomUUID(), type: 'worker-control', address: workerAddress, accepting: false });
      const launched = await workspace.run({ id: crypto.randomUUID(), type: 'launch', goalId }) as { tasks: Array<{ taskId: string }> };
      const taskId = BigInt(launched.tasks[0]!.taskId); assert.equal(taskId, 6n);
      await workspace.run({ id: crypto.randomUUID(), type: 'launch', goalId });
      await cli('worker', '--once'); assert.equal((await getTask(client, config, taskId)).status, 0);
      await workspace.run({ id: crypto.randomUUID(), type: 'worker-control', address: workerAddress, accepting: true });
      await cli('worker', '--once'); assert.equal((await getTask(client, config, taskId)).status, 2);
      await new Reviewer(requester, undefined, () => undefined).tick(); assert.equal((await getTask(client, config, taskId)).status, 3);
      const snapshot = await workspace.snapshot({ chainId: 31337 });
      assert.equal(snapshot.goals[0]!.id, goalId); assert.equal(snapshot.goals[0]!.status, 'completed'); assert.equal(snapshot.goals[0]!.tasks.length, 1);
      assert.equal(snapshot.workers.find(w => w.address === workerAddress)!.accepting, true);
      assert.ok(snapshot.goals[0]!.tasks[0]!.result);
    } finally { await workspaceSigner.close(); workspaceState.close(); }

  } finally { await mcp?.close(); if (daemon) await stop(daemon.child); if (storage) await stop(storage.child); await stop(anvil); await rm(directory, { recursive: true, force: true }); }
});
