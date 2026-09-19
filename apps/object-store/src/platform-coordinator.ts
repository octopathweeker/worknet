import type { DurableObjectState } from '@cloudflare/workers-types';
import { createWalletClient, http, encodeFunctionData, erc20Abi, keccak256, decodeEventLog, parseTransaction, type Address, type Hex, type Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import { taskManagerAbi, requesterVaultAbi } from '@agent-task/contracts';
import { redeemPermission, isSupportedDelegation, type AccountCall } from '@agent-task/accounts';
import { canonicalJson, hashJson, parseJsonStrict } from '@agent-task/protocol/json';
import { platformConfig, platformClient } from './platform-api.js';
import { makeTask, taskParams, serialize, publicPlatformError, type PlatformGoal } from './platform-domain.js';
import { executePlatformTask, verifyPlatformResult } from './platform-execution.js';
import type { Env } from './index.js';

type Role = 'operator' | 'worker' | 'sponsor';
type Outbox = { to: Address; data: Hex; raw: Hex; hash: Hex; status: 'signed' | 'confirmed' | 'reverted'; block?: string; gasPaid?: string; gasDay?: string; reservedGas?: string };
/** A single durable coordinator serializes signing. Only typed internal commands reach this class. */
export class PlatformCoordinator {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}
  async fetch(request: Request) {
    if (new URL(request.url).pathname !== '/wake' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    const alarm = await this.ctx.storage.getAlarm(); if (!alarm || alarm > Date.now() + 2000) await this.ctx.storage.setAlarm(Date.now() + 1000);
    return new Response('ok');
  }
  async alarm() {
    // Alarms are at-least-once and do not overlap for this object. Journals also survive eviction.
    await this.ctx.storage.setAlarm(Date.now() + 15000);
    let error: string | undefined;
    await this.migrateGasLedger();
    // A blocked new command must never prevent reviewing already funded work.
    for (const work of [() => this.indexEvents(), () => this.processCommand(), () => this.advanceGoal()]) {
      try { await work(); }
      catch (e) { if (!String(e).includes('AWAITING_FINALITY')) { error = publicPlatformError(e); console.error('platform-tick', String(e).slice(0, 1000)); } }
    }
    await this.env.DB!.prepare("INSERT INTO platform_health(id,body,updated_at) VALUES ('current',?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at").bind(serialize({ ready: !error, ...(error ? { error } : {}), service: 'cloudflare-durable-coordinator' }), Date.now()).run();
    const pending = await this.env.DB!.prepare("SELECT (SELECT count(*) FROM platform_commands WHERE status IN ('queued','processing')) + (SELECT count(*) FROM platform_goals WHERE active=1) AS n").first<{ n: number }>();
    if (pending?.n) await this.ctx.storage.setAlarm(Date.now() + 1500); else await this.ctx.storage.setAlarm(Date.now() + 60000);
    await this.env.DB!.prepare('DELETE FROM platform_challenges WHERE expires_at<?').bind(Date.now() - 3600000).run();
    await this.env.DB!.prepare('DELETE FROM platform_sessions WHERE expires_at<?').bind(Date.now()).run();
    await this.env.DB!.prepare('DELETE FROM platform_rate WHERE expires_at<?').bind(Date.now() - 86400000).run();
  }
  private async migrateGasLedger() {
    if (await this.ctx.storage.get('gas-ledger-v2')) return;
    const client = platformClient(platformConfig(this.env)); const totals: Record<string, bigint> = {}; let after: string | undefined;
    while (true) {
      const rows = await this.ctx.storage.list<Outbox>({ prefix: 'tx:', limit: 128, ...(after ? { startAfter: after } : {}) });
      for (const [key, entry] of rows) {
        const transaction = parseTransaction(entry.raw);
        entry.reservedGas ??= ((transaction.gas ?? 0n) * (transaction.maxFeePerGas ?? transaction.gasPrice ?? 0n)).toString();
        const date = entry.block ? new Date(Number((await client.getBlock({ blockNumber: BigInt(entry.block) })).timestamp) * 1000) : new Date();
        entry.gasDay ??= `gas:${date.toISOString().slice(0, 10)}`;
        totals[entry.gasDay] = (totals[entry.gasDay] ?? 0n) + BigInt(entry.status === 'signed' ? entry.reservedGas : entry.gasPaid ?? entry.reservedGas);
        await this.ctx.storage.put(key, entry); after = key;
      }
      if (rows.size < 128) break;
    }
    await this.ctx.storage.put({ ...Object.fromEntries(Object.entries(totals).map(([k,v]) => [k,v.toString()])), 'gas-ledger-v2': true });
  }
  private async indexEvents() {
    const config = platformConfig(this.env); if (!config.deploymentBlock) return;
    const client = platformClient(config); const head = await client.getBlock({ blockTag: 'finalized' });
    const cursor = await this.ctx.storage.get<{ next: string; hash: Hex }>('event-cursor');
    let from = BigInt(cursor?.next ?? config.deploymentBlock);
    if (cursor && (await client.getBlock({ blockNumber: from - 1n })).hash !== cursor.hash) throw new Error('FINALIZED_HISTORY_CHANGED');
    for (let page = 0; page < 3 && from <= head.number; page++) {
      const to = from + 99n < head.number ? from + 99n : head.number;
      const logs = await client.getLogs({ address: config.manager, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const decoded = decodeEventLog({ abi: taskManagerAbi, data: log.data, topics: log.topics });
        if (!('taskId' in decoded.args)) continue;
        const event = { event: decoded.eventName, args: decoded.args, transactionHash: log.transactionHash, blockNumber: log.blockNumber };
        await this.env.DB!.prepare('INSERT OR IGNORE INTO platform_events(id,task_id,block_number,body) VALUES (?,?,?,?)').bind(`${log.blockHash}:${log.transactionHash}:${log.logIndex}`, decoded.args.taskId.toString(), Number(log.blockNumber), serialize(event)).run();
      }
      await this.ctx.storage.put('event-cursor', { next: (to + 1n).toString(), hash: (await client.getBlock({ blockNumber: to })).hash }); from = to + 1n;
    }
  }
  private async write(role: Role, intent: string, to: Address, data: Hex): Promise<Outbox> {
    const config = platformConfig(this.env); const client = platformClient(config);
    const key = this.env[role === 'operator' ? 'PLATFORM_OPERATOR_KEY' : role === 'worker' ? 'PLATFORM_WORKER_KEY' : 'PLATFORM_SPONSOR_KEY'];
    if (!key) throw new Error('SIGNER_UNAVAILABLE'); const account = privateKeyToAccount(key as Hex);
    if (account.address.toLowerCase() !== config[role].toLowerCase()) throw new Error('SIGNER_MISMATCH');
    const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(config.rpcUrl, { timeout: 15000, retryCount: 1 }) });
    const id = `tx:${role}:${intent}`;
    const confirm = async (key: string, entry: Outbox) => {
      if (entry.status === 'reverted') throw new Error(`TRANSACTION_REVERTED:${entry.hash}`);
      if (entry.status === 'confirmed') return entry;
      let receipt = await client.getTransactionReceipt({ hash: entry.hash }).catch(() => undefined);
      if (!receipt) { try { await client.sendRawTransaction({ serializedTransaction: entry.raw }); } catch { /* Receipt determines outcome; never sign a replacement. */ } receipt = await client.waitForTransactionReceipt({ hash: entry.hash, timeout: 20000, pollingInterval: 1000 }); }
      for (let i = 0; (await client.getBlock({ blockTag: 'finalized' })).number < receipt.blockNumber; i++) {
        if (i >= 8) throw new Error('AWAITING_FINALITY');
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('RECEIPT_BLOCK_CHANGED');
      entry.status = receipt.status === 'success' ? 'confirmed' : 'reverted'; entry.block = receipt.blockNumber.toString(); entry.gasPaid = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
      const refund = BigInt(entry.reservedGas ?? entry.gasPaid) - BigInt(entry.gasPaid);
      const updates: Record<string, unknown> = { [key]: entry };
      if (entry.gasDay && refund > 0n) { const spent = BigInt(await this.ctx.storage.get<string>(entry.gasDay) ?? '0'); updates[entry.gasDay] = (spent > refund ? spent - refund : 0n).toString(); }
      await this.ctx.storage.put(updates); await this.ctx.storage.delete(`pending:${role}`);
      if (entry.status === 'reverted') throw new Error(`TRANSACTION_REVERTED:${entry.hash}`); return entry;
    };
    const prior = await this.ctx.storage.get<Outbox>(id);
    if (prior) { if (prior.to.toLowerCase() !== to.toLowerCase() || prior.data !== data) throw new Error('TRANSACTION_INTENT_CONFLICT'); return confirm(id, prior); }
    const pending = await this.ctx.storage.get<string>(`pending:${role}`);
    if (pending) { const entry = await this.ctx.storage.get<Outbox>(pending); if (!entry) throw new Error('OUTBOX_CORRUPT'); await confirm(pending, entry); }
    await client.call({ account, to, data });
    const gas = await client.estimateGas({ account, to, data }); if (gas > 5000000n) throw new Error('SPONSOR_LIMIT');
    const request = await wallet.prepareTransactionRequest({ to, data, gas: gas * 120n / 100n, nonce: await client.getTransactionCount({ address: account.address, blockTag: 'pending' }) });
    const maxFee = request.maxFeePerGas ?? request.gasPrice ?? 0n; if (maxFee > 300000000000n) throw new Error('SPONSOR_LIMIT');
    const day = `gas:${new Date().toISOString().slice(0, 10)}`; const spent = BigInt(await this.ctx.storage.get<string>(day) ?? '0'); const reserve = request.gas! * maxFee;
    // Stop new commitments at the daily sponsorship threshold. Already funded tasks must
    // still be deliverable, reviewed, released or refunded; a quota must not force timeout payment.
    const completingTask = role === 'operator' && /^(accept|reject|expire|cancel-after-failed-attempts):/.test(intent)
      || role === 'worker' && /^(submit|release|review-timeout-settlement):/.test(intent);
    if (spent + reserve > 2000000000000000000n && !completingTask) throw new Error('SPONSOR_LIMIT');
    const raw = await wallet.signTransaction(request); const entry: Outbox = { to, data, raw, hash: keccak256(raw), status: 'signed', gasDay: day, reservedGas: reserve.toString() };
    await this.ctx.storage.put({ [id]: entry, [`pending:${role}`]: id, [day]: (spent + reserve).toString() });
    return confirm(id, entry);
  }
  private call(role: Role, intent: string, address: Address, abi: Abi, functionName: string, args: readonly unknown[]) { return this.write(role, intent, address, encodeFunctionData({ abi, functionName, args })); }
  private async storeGoal(goal: PlatformGoal, active = true) { await this.env.DB!.prepare('UPDATE platform_goals SET body=?,active=?,updated_at=? WHERE id=? AND owner=?').bind(serialize(goal), active ? 1 : 0, Date.now(), goal.id, goal.owner).run(); }
  private async reserveModelCall(amount = 1) {
    const key = `model-calls:${new Date().toISOString().slice(0, 10)}`;
    const count = await this.ctx.storage.get<number>(key) ?? 0;
    if (count + amount > 100) throw new Error('MODEL_DAILY_LIMIT');
    await this.ctx.storage.put(key, count + amount);
  }
  private async put(value: unknown) {
    const body = canonicalJson(value); const hash = hashJson(value); await this.env.DB!.prepare('INSERT OR IGNORE INTO objects(hash,body,created_at) VALUES (?,?,?)').bind(hash, body, Date.now()).run(); return { hash, uri: `${platformConfig(this.env).storageUrl}/objects/${hash}` };
  }
  private async getObject(uri: string, hash: Hex) {
    if (uri !== `${platformConfig(this.env).storageUrl}/objects/${hash}`) throw new Error('STORAGE_URI_NOT_ALLOWED');
    const row = await this.env.DB!.prepare('SELECT body FROM objects WHERE hash=?').bind(hash).first<{ body: string }>(); if (!row) throw new Error('RESULT_NOT_AVAILABLE'); const value = parseJsonStrict(row.body); if (hashJson(value) !== hash) throw new Error('RESULT_HASH_MISMATCH'); return value;
  }
  private async processCommand() {
    const row = await this.env.DB!.prepare("SELECT id,owner,type,payload FROM platform_commands WHERE status IN ('queued','processing') ORDER BY created_at LIMIT 1").first<{ id: string; owner: Address; type: string; payload: string }>(); if (!row) return;
    await this.env.DB!.prepare("UPDATE platform_commands SET status='processing' WHERE id=?").bind(row.id).run();
    const payload = JSON.parse(row.payload); const config = platformConfig(this.env); const client = platformClient(config);
    try {
      let result: unknown;
      if (row.type === 'setup') {
        const entry = await this.env.DB!.prepare('SELECT body FROM platform_intents WHERE id=? AND owner=?').bind(row.id, row.owner).first<{ body: string }>(); if (!entry) throw new Error('INTENT_EXPIRED');
        const intent = JSON.parse(entry.body);
        if (!isSupportedDelegation(await client.getCode({ address: row.owner }))) throw new Error('WRONG_DELEGATION');
        const calls: AccountCall[] = intent.calls.map((c: any) => ({ ...c, value: BigInt(c.value) }));
        const execution = redeemPermission({ ...intent.delegation, signature: payload.signature }, calls);
        const receipt = await this.write('sponsor', row.id, execution.to, execution.data);
        result = { transactionHash: receipt.hash, vault: intent.vault };
      } else if (row.type === 'launch') {
        const entry = await this.env.DB!.prepare('SELECT body FROM platform_goals WHERE id=? AND owner=?').bind(payload.goalId, row.owner).first<{ body: string }>(); if (!entry) throw new Error('GOAL_NOT_FOUND');
        const goal = JSON.parse(entry.body) as PlatformGoal;
        if (goal.taskId) { await this.storeGoal(goal); result = { goalId: goal.id, taskId: goal.taskId }; }
        else {
          const head = await client.getBlock({ blockTag: 'finalized' });
          const [authorization, balance, paused] = await Promise.all([client.readContract({ address: goal.vault, abi: requesterVaultAbi, functionName: 'getAuthorization', args: [config.operator] }), client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [goal.vault] }), client.readContract({ address: goal.vault, abi: requesterVaultAbi, functionName: 'paused' })]);
          // Freeze before any publication or signature; restart always uses the identical spec.
          if (!goal.spec) { goal.spec = makeTask(goal, config, Number(head.timestamp), head.number); goal.status = 'queued'; await this.storeGoal(goal, false); }
          const params = taskParams(goal.spec, config.storageUrl);
          let taskId = await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getTaskByRequestId', args: [goal.vault, goal.spec.clientRequestId as Hex], blockTag: 'finalized' });
          if (!taskId) {
            const pendingId = await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getTaskByRequestId', args: [goal.vault, goal.spec.clientRequestId as Hex] });
            if (pendingId) throw new Error('AWAITING_FINALITY');
            if (paused || !authorization.active || authorization.validAfter > head.timestamp || authorization.validUntil <= BigInt(goal.spec.execution.taskDeadline + goal.spec.execution.reviewWindowSeconds) || params.rewardAmount > authorization.maxPerTask || params.rewardAmount + authorization.committed > authorization.maxTotalCommitment || balance < params.rewardAmount) throw new Error('BUDGET_UNAVAILABLE');
            await this.put(goal.spec);
            const receipt = await this.call('operator', `launch:${goal.id}`, goal.vault, requesterVaultAbi, 'createTask', [goal.spec.clientRequestId, params]);
            goal.events = [{ event: 'TaskCreated', transactionHash: receipt.hash, blockNumber: receipt.block }];
            taskId = await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getTaskByRequestId', args: [goal.vault, goal.spec.clientRequestId as Hex], blockTag: 'finalized' });
          }
          if (!taskId) throw new Error('TASK_NOT_CONFIRMED');
          goal.taskId = taskId.toString(); goal.status = 'running'; delete goal.error; await this.storeGoal(goal); result = { goalId: goal.id, taskId: goal.taskId };
        }
      } else throw new Error('UNKNOWN_COMMAND');
      await this.env.DB!.prepare("UPDATE platform_commands SET status='complete',result=? WHERE id=?").bind(serialize(result), row.id).run();
    } catch (error) {
      const text = String(error);
      // A deterministic contract revert must not keep a tenant's command at the head forever.
      const permanent = /BUDGET_UNAVAILABLE|INVALID_BLOCK_RANGE|SOURCE_NOT_ALLOWED|INTENT_EXPIRED|WRONG_DELEGATION|TRANSACTION_REVERTED|GOAL_NOT_FOUND|execution reverted|reverted with/i.test(text);
      if (permanent) await this.env.DB!.prepare("UPDATE platform_commands SET status='failed',result=? WHERE id=?").bind(serialize({ error: publicPlatformError(error) }), row.id).run();
      else { await this.env.DB!.prepare('UPDATE platform_commands SET result=? WHERE id=?').bind(serialize(text.includes('AWAITING_FINALITY') ? { pending: 'finality', retrying: true } : { error: publicPlatformError(error), retrying: true }), row.id).run(); throw error; }
    }
  }
  private async advanceGoal() {
    // Round-robin through active goals so one unavailable task cannot starve others.
    const row = await this.env.DB!.prepare('SELECT body FROM platform_goals WHERE active=1 ORDER BY updated_at LIMIT 1').first<{ body: string }>(); if (!row) return;
    const goal = JSON.parse(row.body) as PlatformGoal; const config = platformConfig(this.env); const client = platformClient(config);
    try {
      if (!goal.taskId || !goal.spec) throw new Error('MISSING_SPEC'); const id = BigInt(goal.taskId); const spec = goal.spec;
      let task = await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getTask', args: [id], blockTag: 'finalized' });
      if (task.requester.toLowerCase() !== goal.vault.toLowerCase() || task.specHash !== hashJson(spec)) throw new Error('TASK_BINDING_MISMATCH');
      goal.task = task;
      delete goal.error;
      const indexed = await this.env.DB!.prepare('SELECT json_group_array(json(body)) AS items FROM (SELECT body FROM platform_events WHERE task_id=? ORDER BY block_number)').bind(id.toString()).first<{ items: string }>();
      const indexedEvents = JSON.parse(indexed?.items ?? '[]');
      if (indexedEvents.length) goal.events = [...(goal.events ?? []).filter(e => !indexedEvents.some((i: any) => i.transactionHash === e.transactionHash)), ...indexedEvents];
      const history = new Map((goal.verificationHistory ?? []).map(e => [`${e.attempt}:${e.resultHash}`, e]));
      if (goal.evidence) history.set(`${goal.evidence.attempt}:${goal.evidence.resultHash}`, goal.evidence);
      for (const event of indexedEvents.filter((e: any) => e.event === 'ResultSubmitted')) {
        const key = `${event.args.attempt}:${event.args.resultHash}`;
        if (!history.has(key)) { const evidence = await this.ctx.storage.get(`review:${id}:${key}`); if (evidence) history.set(key, evidence); }
      }
      goal.verificationHistory = [...history.values()];
      if (goal.evidence && (goal.evidence.attempt !== task.attempt.toString() || goal.evidence.resultHash !== task.resultHash)) { delete goal.evidence; delete goal.result; }
      if (task.status >= 3) { goal.status = task.status === 3 && goal.audit?.verdict !== 'reject' && goal.evidence?.verdict === 'accept' && goal.evidence.attempt === task.attempt.toString() && goal.evidence.resultHash === task.resultHash ? 'completed' : 'attention'; if (goal.audit?.verdict === 'reject') goal.error = goal.audit.reason; await this.storeGoal(goal, false); return; }
      const now = (await client.getBlock()).timestamp;
      const event = async (role: Role, action: string, address: Address, abi: Abi, fn: string, args: unknown[]) => {
        const tx = await this.call(role, `${action}:${id}:${task.attempt}:${task.resultHash}`, address, abi, fn, args);
        goal.events = [...(goal.events ?? []), { event: action, transactionHash: tx.hash, blockNumber: tx.block, attempt: task.attempt.toString() }].slice(-30); return tx;
      };
      if (task.status === 0 || task.status === 1) {
        if (now >= task.taskDeadline) { await event('operator', 'expire', config.manager, taskManagerAbi, 'expireTask', [id]); await this.storeGoal(goal); return; }
        if (task.status === 1 && now >= task.claimLeaseExpiresAt) { await event('worker', 'release', config.manager, taskManagerAbi, 'releaseExpiredClaim', [id]); await this.storeGoal(goal); return; }
      }
      if (task.status === 0) {
        if (task.attempt >= 2n) { await event('operator', 'cancel-after-failed-attempts', goal.vault, requesterVaultAbi, 'cancelTask', [id]); goal.error = '两轮执行未完成，已取消并退还剩余托管奖励。'; await this.storeGoal(goal); return; }
        await event('worker', 'claim', config.manager, taskManagerAbi, 'claimTask', [id]); await this.storeGoal(goal); return;
      }
      if (task.status === 1 && task.worker.toLowerCase() === config.worker.toLowerCase()) {
        if (task.claimLeaseExpiresAt - now < 45n) { goal.error = '执行租约即将到期，等待释放后恢复。'; await this.storeGoal(goal); return; }
        const jobAttempt = task.attempt; const jobKey = `result:${id}:${jobAttempt}`; let job = await this.ctx.storage.get<{ hash: Hex; uri: string }>(jobKey);
        if (!job) {
          const triesKey = `execution-tries:${id}:${jobAttempt}`; const tries = await this.ctx.storage.get<number>(triesKey) ?? 0;
          if (tries >= 2) { goal.error = '本轮执行两次未完成，等待领取租约释放后恢复；不会持续消耗模型额度。'; await this.storeGoal(goal); return; }
          await this.ctx.storage.put(triesKey, tries + 1);
          if (spec.capability === 'research.web') await this.reserveModelCall();
          const previous = (goal.verificationHistory ?? []).findLast(e => e.verdict === 'reject' && BigInt(e.attempt) < jobAttempt);
          let feedback: unknown;
          if (previous) {
            const priorResult = await this.getObject(`${config.storageUrl}/objects/${previous.resultHash}`, previous.resultHash).catch(() => null) as any;
            feedback = { previousOutput: priorResult?.output, checks: previous.checks };
          }
          const execution = await executePlatformTask(spec, config, this.env, feedback);
          const result = { protocol: 'agent-task/0.1', settlementChainId: '10143', taskManager: config.manager.toLowerCase(), taskId: id.toString(), attempt: task.attempt.toString(), worker: config.worker.toLowerCase(), specHash: task.specHash, output: execution.output, artifacts: [], provenance: execution.provenance };
          job = await this.put(result); await this.ctx.storage.put(jobKey, job);
        }
        task = await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getTask', args: [id] });
        if (task.status !== 1 || task.attempt !== jobAttempt || task.worker.toLowerCase() !== config.worker.toLowerCase() || (await client.getBlock()).timestamp >= task.claimLeaseExpiresAt) { await this.storeGoal(goal); return; }
        await event('worker', 'submit', config.manager, taskManagerAbi, 'submitResult', [id, task.attempt, job.hash, job.uri]); delete goal.error; await this.storeGoal(goal); return;
      }
      if (task.status === 2) {
        if (now >= task.reviewDeadline) { await event('worker', 'review-timeout-settlement', config.manager, taskManagerAbi, 'finalize', [id]); goal.error = '审核窗口已结束并发生超时结算；这不代表验证通过。'; await this.storeGoal(goal); return; }
        const authority = await client.readContract({ address: goal.vault, abi: requesterVaultAbi, functionName: 'getTaskAuthority', args: [id] });
        const auth = await client.readContract({ address: goal.vault, abi: requesterVaultAbi, functionName: 'getAuthorization', args: [config.operator] });
        if (!auth.active || authority.epoch !== auth.epoch || authority.operator.toLowerCase() !== config.operator.toLowerCase() || now >= auth.validUntil) { goal.error = 'USER_ACTION_REQUIRED：授权已改变，请 Owner 在审核期限内接管；否则可能超时付款。'; goal.status = 'attention'; await this.storeGoal(goal); return; }
        const reviewKey = `review:${id}:${task.attempt}:${task.resultHash}`;
        let evidence = await this.ctx.storage.get<any>(reviewKey);
        if (!evidence) {
          const triesKey = `tries:${reviewKey}`; const tries = await this.ctx.storage.get<number>(triesKey) ?? 0;
          await this.ctx.storage.put(triesKey, tries + 1);
          try {
            if (spec.capability === 'research.web') await this.reserveModelCall(2);
            const result = await this.getObject(task.resultURI, task.resultHash) as any;
            if (result.protocol !== 'agent-task/0.1' || result.settlementChainId !== '10143' || result.taskManager !== config.manager.toLowerCase() || result.taskId !== id.toString() || result.attempt !== task.attempt.toString() || result.worker !== task.worker.toLowerCase() || result.specHash !== task.specHash) throw new Error('RESULT_BINDING_MISMATCH');
            goal.result = result; evidence = { ...await verifyPlatformResult(spec, result, config, this.env), attempt: task.attempt.toString(), resultHash: task.resultHash };
          } catch (error) {
            if (tries < 2 && task.reviewDeadline - now > 90n && !/ZodError|RESULT_BINDING_MISMATCH|RESULT_HASH_MISMATCH|MODEL_DAILY_LIMIT/.test(String(error))) throw error;
            evidence = { verdict: 'reject', attempt: task.attempt.toString(), resultHash: task.resultHash, checks: [{ name: 'verification-available', passed: false, detail: '无法在审核期限内完成有效验证，拒绝当前提交。' }], checkedAt: new Date().toISOString() };
          }
          await this.ctx.storage.put(reviewKey, evidence);
        }
        if (!goal.result) goal.result = await this.getObject(task.resultURI, task.resultHash).catch(() => undefined);
        goal.evidence = evidence; await this.storeGoal(goal);
        if (evidence.verdict === 'accept') await event('operator', 'accept', goal.vault, requesterVaultAbi, 'acceptResult', [id, task.attempt, task.resultHash]);
        else await event('operator', 'reject', goal.vault, requesterVaultAbi, 'rejectResult', [id, task.attempt, task.resultHash, hashJson(evidence)]);
        delete goal.error; await this.storeGoal(goal); return;
      }
      await this.storeGoal(goal);
    } catch (error) { if (!String(error).includes('AWAITING_FINALITY')) goal.error = publicPlatformError(error); else delete goal.error; await this.storeGoal(goal); throw error; }
  }
}
