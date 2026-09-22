import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createPublicClient, createWalletClient, http, bytesToHex, erc20Abi, decodeFunctionData, type Address } from 'viem';
import { monadTestnet } from 'viem/chains';
import { mnemonicToAccount } from 'viem/accounts';
import { requesterVaultAbi, taskManagerAbi } from '@agent-task/contracts';
import { factoryAbi } from '@agent-task/accounts';
import { PlatformCoordinator } from '../apps/object-store/src/platform-coordinator.js';
import { platformApi } from '../apps/object-store/src/platform-api.js';
import { makeTask } from '../apps/object-store/src/platform-domain.js';
import type { Env } from '../apps/object-store/src/index.js';

test('two-user cloud coordinator survives signed transaction crash and settles independently on local Monad', { timeout: 120000 }, async () => {
  const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const port = (server.address() as { port: number }).port; await new Promise<void>(r => server.close(() => r()));
  const anvil = spawn('.tools/foundry/anvil', ['--network', 'monad', '--hardfork', 'MonadNine', '--chain-id', '10143', '--block-time', '1', '--port', String(port), '--silent'], { stdio: 'ignore' });
  const rpc = `http://127.0.0.1:${port}`; const nativeFetch = globalThis.fetch;
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync('apps/object-store/schema.sql', 'utf8')); db.exec(readFileSync('apps/object-store/platform-schema.sql', 'utf8'));
  const accounts = Array.from({ length: 5 }, (_, addressIndex) => mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex }));
  const client = createPublicClient({ chain: monadTestnet, transport: http(rpc), pollingInterval: 100 });
  const wallets = accounts.map(account => createWalletClient({ chain: monadTestnet, account, transport: http(rpc) }));
  try {
    for (let i = 0; ; i++) { try { await client.getChainId(); break; } catch { if (i > 40) throw new Error('anvil startup timeout'); await new Promise(r => setTimeout(r, 100)); } }
    async function deploy(name: string, args: unknown[] = []) { const artifact = JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, 'utf8')); const hash = await wallets[0]!.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args }); const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success'); return receipt.contractAddress!; }
    const testJudges = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'];
  const token = await deploy('MockUSDC'); const manager = await deploy('TaskManager', [token, testJudges, 1]); const factory = await deploy('RequesterVaultFactory', [manager, token]);
    const vaults: Address[] = [];
    for (const i of [3, 4]) {
      let hash = await wallets[0]!.writeContract({ address: token, abi: [...erc20Abi, { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [] }], functionName: 'mint', args: [accounts[i]!.address, 1000000n] }); await client.waitForTransactionReceipt({ hash });
      hash = await wallets[i]!.writeContract({ address: factory, abi: factoryAbi, functionName: 'createVault', args: [accounts[i]!.address] }); await client.waitForTransactionReceipt({ hash });
      const vault = await client.readContract({ address: factory, abi: factoryAbi, functionName: 'vaultOf', args: [accounts[i]!.address] }); vaults.push(vault);
      hash = await wallets[i]!.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [vault, 500000n] }); await client.waitForTransactionReceipt({ hash });
      hash = await wallets[i]!.writeContract({ address: vault, abi: requesterVaultAbi, functionName: 'deposit', args: [500000n] }); await client.waitForTransactionReceipt({ hash });
      const now = (await client.getBlock()).timestamp;
      hash = await wallets[i]!.writeContract({ address: vault, abi: requesterVaultAbi, functionName: 'authorizeAgent', args: [accounts[1]!.address, { validAfter: 0n, validUntil: now + 86400n, maxPerTask: 200000n, maxTotalCommitment: 500000n }] }); await client.waitForTransactionReceipt({ hash });
    }
    globalThis.fetch = async (input, init) => {
      if (!String(input).startsWith('https://platform-rpc.test')) return nativeFetch(input, init);
      const payload = JSON.parse(String(init?.body));
      // Local Anvil does not model Monad consensus finality. The Testnet suite verifies real finalized reads.
      if (payload.method === 'eth_getBlockByNumber' && payload.params[0] === 'finalized') payload.params[0] = 'latest';
      if (payload.method === 'eth_call' && payload.params[1] === 'finalized') payload.params[1] = 'latest';
      return nativeFetch(rpc, { ...init, body: JSON.stringify(payload) });
    };
    const memory = new Map<string, unknown>(); let crash = true; let crashed = false;
    const ctx = { storage: {
      async get(key: string) { return structuredClone(memory.get(key)); },
      async list(options: { prefix: string; limit: number; startAfter?: string }) { return new Map([...memory.entries()].filter(([key]) => key.startsWith(options.prefix) && (!options.startAfter || key > options.startAfter)).sort(([a],[b]) => a.localeCompare(b)).slice(0, options.limit).map(([key,value]) => [key,structuredClone(value)])); },
      async put(key: string | Record<string, unknown>, value?: unknown) { if ((typeof key === 'string' && key.startsWith('tx:operator:launch:') && (value as any)?.status === 'confirmed' || typeof key !== 'string' && Object.entries(key).some(([k,v]) => k.startsWith('tx:operator:launch:') && (v as any)?.status === 'confirmed')) && crash) { crash = false; crashed = true; throw new Error('injected process loss after mined transaction'); } if (typeof key === 'string') memory.set(key, structuredClone(value)); else for (const [k,v] of Object.entries(key)) memory.set(k, structuredClone(v)); },
      async delete(key: string) { memory.delete(key); }, async setAlarm(value: number) { memory.set('alarm', value); }, async getAlarm() { return memory.get('alarm') ?? null; },
    } };
    let coordinator: PlatformCoordinator;
    const env: Env = {
      PLATFORM_CONFIG: JSON.stringify({ chainId: 10143, token, manager, factory, operator: accounts[1]!.address, worker: accounts[2]!.address, sponsor: accounts[0]!.address, deploymentBlock: '0', rpcUrl: 'https://platform-rpc.test', storageUrl: 'https://platform.test' }),
      PLATFORM_OPERATOR_KEY: bytesToHex(accounts[1]!.getHdKey().privateKey!), PLATFORM_WORKER_KEY: bytesToHex(accounts[2]!.getHdKey().privateKey!), PLATFORM_SPONSOR_KEY: bytesToHex(accounts[0]!.getHdKey().privateKey!),
      PLATFORM: { idFromName: () => 'one', get: () => ({ fetch: (url: string, init: RequestInit) => coordinator.fetch(new Request(url, init)) }) } as any,
      DB: { prepare(sql) { let values: SQLInputValue[] = []; return { bind(...args) { values = args as SQLInputValue[]; return this; }, async first<T>() { return (db.prepare(sql).get(...values) ?? null) as T | null; }, async run() { return db.prepare(sql).run(...values); } }; } },
    };
    coordinator = new PlatformCoordinator(ctx as any, env);
    const api = (route: string, body?: unknown, cookie = '') => platformApi(new Request(`https://platform.test/platform/${route}`, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { origin: 'https://platform.test', 'content-type': 'application/json', cookie } }), env);
    const cookies: string[] = []; const commands: string[] = [];
    for (const i of [3,4]) {
      const challenge = await (await api('auth/challenge', { address: accounts[i]!.address })).json() as any;
      const login = await api('auth/verify', { id: challenge.id, signature: await accounts[i]!.signMessage({ message: challenge.message }) }); assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie')!.split(';')[0]!; cookies.push(cookie);
      if (i === 3) {
        // A funded vault with expired payment permission must recover without a deposit.
        const vault = vaults[0]!;
        const now = (await client.getBlock()).timestamp;
        const expiredAuth = await wallets[i]!.writeContract({ address: vault, abi: requesterVaultAbi, functionName: 'authorizeAgent', args: [accounts[1]!.address, { validAfter: 0n, validUntil: now + 10n, maxPerTask: 200000n, maxTotalCommitment: 500000n }] });
        await client.waitForTransactionReceipt({ hash: expiredAuth });
        await client.request({ method: 'evm_increaseTime' as any, params: [11] as any });
        await client.request({ method: 'evm_mine' as any });
        const before = await (await api('account', undefined, cookie)).json() as any;
        assert.equal(before.budget.vaultBalance, '500000');
        assert.equal(before.budget.effectiveActive, false);
        assert.equal(before.budget.newCommitmentCapacity, '0');
        assert.equal((await api('setup', { id: crypto.randomUUID(), amount: '600000', mode: 'authorize' }, cookie)).status, 400);
        const intent = { id: crypto.randomUUID(), amount: '500000', mode: 'authorize' };
        const preparedResponse = await api('setup', intent, cookie); assert.equal(preparedResponse.status, 200);
        const prepared = await preparedResponse.json() as any;
        assert.equal(prepared.calls.length, 1, 'renewal contains no approve, deposit or token transfer');
        assert.equal(decodeFunctionData({ abi: requesterVaultAbi, data: prepared.calls[0].callData }).functionName, 'authorizeAgent');
        assert.deepEqual(await (await api('setup', intent, cookie)).json(), prepared, 'retry preserves exact authorization intent');
        assert.equal((await api('setup', { ...intent, mode: 'recharge' }, cookie)).status, 409, 'renewal cannot be replayed as a deposit');
        const hash = await wallets[i]!.sendTransaction({ to: prepared.calls[0].target, data: prepared.calls[0].callData });
        assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success');
        const after = await (await api('account', undefined, cookie)).json() as any;
        assert.equal(after.budget.vaultBalance, before.budget.vaultBalance);
        assert.equal(after.walletBalance, before.walletBalance);
        assert.equal(after.budget.effectiveActive, true);
        assert.equal(after.budget.newCommitmentCapacity, '500000');
        assert(BigInt(after.chainTimestamp) >= now + 11n);
        const renewedAuth = await client.readContract({ address: vault, abi: requesterVaultAbi, functionName: 'getAuthorization', args: [accounts[1]!.address] });
        // Even if a retired wallet request arrives later, its expired final permission cannot
        // overwrite the new epoch. This is why lost old batch status need not block publishing.
        const late = await wallets[i]!.writeContract({ address: vault, abi: requesterVaultAbi, functionName: 'authorizeAgent', gas: 200000n, args: [accounts[1]!.address, { validAfter: 0n, validUntil: now + 10n, maxPerTask: 200000n, maxTotalCommitment: 500000n }] });
        assert.equal((await client.waitForTransactionReceipt({ hash: late })).status, 'reverted');
        assert.deepEqual(await client.readContract({ address: vault, abi: requesterVaultAbi, functionName: 'getAuthorization', args: [accounts[1]!.address] }), renewedAuth);

      }
      const id = crypto.randomUUID(); const input = { id, goal: `独立用户 ${i} 的确定性转账统计任务`, kind: 'analysis', reward: '50000', fromBlock: '1', toBlock: '2' };
      assert.equal((await api('plans', input, cookie)).status, 200);
      const command = { id: crypto.randomUUID(), goalId: id }; commands.push(command.id);
      assert.equal((await api('launch', command, cookie)).status, 202); assert.equal((await api('launch', command, cookie)).status, 202);
    }
    const expired = JSON.parse(String(db.prepare('SELECT body FROM platform_goals LIMIT 1').get()!.body)); expired.id = crypto.randomUUID(); expired.input.id = expired.id;
    const head = await client.getBlock(); expired.spec = makeTask(expired, JSON.parse(env.PLATFORM_CONFIG!), Number(head.timestamp) - 7200, head.number);
    db.prepare('INSERT INTO platform_goals(id,owner,body,updated_at) VALUES (?,?,?,0)').run(expired.id, expired.owner, JSON.stringify(expired));
    const expiredCommand = crypto.randomUUID(); db.prepare("INSERT INTO platform_commands(id,owner,type,fingerprint,payload,created_at) VALUES (?,?,'launch','fixture',?,0)").run(expiredCommand, expired.owner, JSON.stringify({ goalId: expired.id }));
    await coordinator.alarm(); assert.equal(db.prepare('SELECT status FROM platform_commands WHERE id=?').get(expiredCommand)!.status, 'failed');
    await coordinator.alarm(); assert(crashed, JSON.stringify(db.prepare('SELECT status,result FROM platform_commands').all())); assert.equal(db.prepare("SELECT count(*) n FROM platform_commands WHERE status='processing'").get()!.n, 1);
    coordinator = new PlatformCoordinator(ctx as any, env); // New process, same durable storage/database.
    let quotaInjected = false; let blockedGoal: any; let quotaCommand = ''; let followupCommand = '';
    // Model the scheduler reaching the transient retry time without a wall-clock sleep.
    db.exec("UPDATE platform_commands SET result=json_remove(result,'$.retryAt') WHERE status='processing'");
    for (let i = 0; i < 24; i++) {
      await coordinator.alarm();
      for (const row of db.prepare("SELECT id,body FROM platform_goals WHERE json_extract(body,'$.task.status')=0 AND json_extract(body,'$.taskId') IS NOT NULL").all()) {
        const legacy=JSON.parse(String(row.body)); if(legacy.id===blockedGoal?.id) continue;
        const task=await client.readContract({address:manager,abi:taskManagerAbi,functionName:'getTask',args:[BigInt(legacy.taskId)]});
        if(task.status!==0) continue;
        assert(![...memory.keys()].some(k=>k.startsWith(`tx:worker:claim:${legacy.taskId}:`)), 'coordinator must never claim');
        await client.waitForTransactionReceipt({hash:await wallets[2]!.writeContract({address:manager,abi:taskManagerAbi,functionName:'claimTask',args:[BigInt(legacy.taskId)]})});
        legacy.input.execution='platform'; // Historical, already claimed work drains after retirement.
        db.prepare('UPDATE platform_goals SET body=? WHERE id=?').run(JSON.stringify(legacy),row.id!);
      }
      if (!quotaInjected && db.prepare("SELECT count(*) n FROM platform_goals WHERE json_extract(body,'$.task.status') IN (1,2,3)").get()!.n === 2) {
        memory.set(`gas:${new Date().toISOString().slice(0,10)}`, '3000000000000000000'); quotaInjected = true;
        const blocked = {...expired, id: crypto.randomUUID(), spec: undefined}; blocked.input = {...blocked.input, id: blocked.id, execution: 'market'}; blockedGoal = blocked; quotaCommand = crypto.randomUUID(); followupCommand = crypto.randomUUID();
        db.prepare('INSERT INTO platform_goals(id,owner,body,updated_at) VALUES (?,?,?,0)').run(blocked.id, blocked.owner, JSON.stringify(blocked));
        db.prepare("INSERT INTO platform_commands(id,owner,type,fingerprint,payload,created_at) VALUES (?,?,'launch','quota-fixture',?,0)").run(quotaCommand, blocked.owner, JSON.stringify({goalId:blocked.id}));
        const existing = JSON.parse(String(db.prepare("SELECT body FROM platform_goals WHERE json_extract(body,'$.taskId') IS NOT NULL LIMIT 1").get()!.body));
        db.prepare("INSERT INTO platform_commands(id,owner,type,fingerprint,payload,created_at) VALUES (?,?,'launch','followup-fixture',?,1)").run(followupCommand, existing.owner, JSON.stringify({goalId:existing.id}));
      }
      if (db.prepare("SELECT count(*) n FROM platform_goals WHERE json_extract(body,'$.status')='completed'").get()!.n === 2) break;
    }
    assert(quotaInjected, 'exhaust sponsorship while funded tasks still require completion');
    for (let i = 0; i < cookies.length; i++) {
      const goals = await (await api('goals', undefined, cookies[i])).json() as any; const completed = goals.goals.filter((g: any) => g.status === 'completed'); assert.equal(completed.length, 1); assert.equal(completed[0].evidence.verdict, 'accept');
      const auth = await client.readContract({ address: vaults[i]!, abi: requesterVaultAbi, functionName: 'getAuthorization', args: [accounts[1]!.address] }); assert.equal(auth.committed, 50000n);
      assert.equal((await api(`commands/${commands[1-i]}`, undefined, cookies[i])).status, 404);
    }
    assert.equal(await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [accounts[2]!.address] }), 100000n);
    assert.equal(await client.readContract({ address: manager, abi: taskManagerAbi, functionName: 'totalEscrowed' }), 0n);
    assert.equal(db.prepare("SELECT count(*) n FROM platform_events WHERE json_extract(body,'$.event')='TaskSettled'").get()!.n, 2);
    assert(!memory.has('pending:operator')); assert(!memory.has('pending:worker'));
    await coordinator.alarm(); await coordinator.alarm();
    assert.equal(db.prepare('SELECT status FROM platform_commands WHERE id=?').get(quotaCommand)!.status, 'failed');
    assert.equal(db.prepare('SELECT status FROM platform_commands WHERE id=?').get(followupCommand)!.status, 'complete', 'quota failure must not block a later idempotent publication');
    const retryable = JSON.parse(String(db.prepare('SELECT body FROM platform_goals WHERE id=?').get(blockedGoal.id)!.body));
    assert.equal(retryable.status, 'draft'); assert.equal(retryable.spec, undefined, 'unsigned spec must not expire while waiting for renewed quota');
    assert(!memory.has(`tx:operator:launch:${blockedGoal.id}`));
    const budgetHealth = JSON.parse(String(db.prepare("SELECT body FROM platform_health WHERE id='current'").get()!.body));
    assert.equal(budgetHealth.gasBudget.limitWei, '2000000000000000000'); assert.equal(budgetHealth.gasBudget.remainingWei, '0');
    // A reviewed configuration increase permits an explicit retry of the SAME goal.
    env.PLATFORM_DAILY_GAS_LIMIT_MON = '5';
    const retryId = crypto.randomUUID();
    assert.equal((await api('launch', {id:retryId, goalId:blockedGoal.id}, cookies[0])).status, 202);
    await coordinator.alarm();
    assert.equal(db.prepare('SELECT status FROM platform_commands WHERE id=?').get(retryId)!.status, 'complete');
    const recovered = JSON.parse(String(db.prepare('SELECT body FROM platform_goals WHERE id=?').get(blockedGoal.id)!.body));
    assert.equal(recovered.taskId, '3'); assert.equal(recovered.error, undefined);
    assert.equal(await client.readContract({address:manager,abi:taskManagerAbi,functionName:'getTaskByRequestId',args:[recovered.vault,recovered.spec.clientRequestId]}),3n);
    assert.equal((await api('launch', {id:retryId, goalId:blockedGoal.id}, cookies[0])).status, 202);
    await coordinator.alarm();
    assert.equal(await client.readContract({address:manager,abi:taskManagerAbi,functionName:'totalEscrowed'}),50000n,'retry must escrow exactly one task reward');

  } finally { globalThis.fetch = nativeFetch; db.close(); anvil.kill('SIGTERM'); }
});
