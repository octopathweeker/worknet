import { taskManagerAbi } from '@agent-task/contracts';
import { assertTaskSpecBinding, capabilityId, validateTaskSpec, validateResultManifest, type TaskSpec, type ResultManifest } from '@agent-task/protocol';
import { isAddress, parseAbiItem, type Address, type Hex } from 'viem';
import { getTask, getCachedTask, scanTasks, type ChainClient, type Signer } from './chain.js';
import { State } from './state.js';
import { HttpStorage } from './storage.js';
import { checkOutputSchema } from './schema.js';

export interface HandlerContext { signal: AbortSignal; client: ChainClient; chainId: number; }
export interface Execution { output: unknown; provenance: ResultManifest['provenance']; }
export interface Handler { capability: string; accepts?(spec: TaskSpec): boolean; execute(spec: TaskSpec, context: HandlerContext): Promise<Execution>; }

export const transferHandler: Handler = {
  capability: 'analysis.token-transfers',
  async execute(spec, context) {
    const input = spec.input as Record<string, unknown>;
    if (String(input.sourceChainId) !== String(context.chainId) || typeof input.token !== 'string' || !isAddress(input.token)) throw new Error('UNSUPPORTED_DATA_CHAIN_OR_TOKEN');
    if (typeof input.fromBlock !== 'string' || typeof input.toBlock !== 'string' || !/^\d+$/.test(input.fromBlock) || !/^\d+$/.test(input.toBlock)) throw new Error('INVALID_BLOCK_RANGE');
    const from = BigInt(input.fromBlock); const to = BigInt(input.toBlock);
    if (from > to || to - from > 1000n) throw new Error('BLOCK_RANGE_EXCEEDS_WORKER_POLICY');
    context.signal.throwIfAborted();
    const tip = await context.client.getBlock({ blockNumber: to });
    let sum = 0n; let eventCount = 0;
    for (let start = from; start <= to; start += 100n) {
      context.signal.throwIfAborted();
      const end = start + 99n < to ? start + 99n : to;
      const logs = await context.client.getLogs({ address: input.token as Address, event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'), fromBlock: start, toBlock: end, strict: true });
      eventCount += logs.length; sum += logs.reduce((total, log) => total + log.args.value, 0n);
    }
    context.signal.throwIfAborted();
    return { output: { eventCount: String(eventCount), totalAmountBaseUnits: sum.toString() }, provenance: { sourceChainId: String(context.chainId), blockRange: { fromBlock: from.toString(), toBlock: to.toString(), toBlockHash: tip.hash }, toolVersion: 'transfer-worker/0.1.1' } };
  },
};

export class WorkerRuntime {
  constructor(readonly signer: Signer, readonly state: State, readonly storage: HttpStorage, readonly handlers: Handler[], readonly log: (event: unknown) => void = console.log) {}
  private scope(id: bigint) { return `${this.signer.config.chainId}:${this.signer.config.manager}:${id}`; }
  async tick(policy: { acceptNewTasks?: boolean } = {}): Promise<void> {
    const { config, client, account } = this.signer;
    const ids = await scanTasks(client, config, this.state);
    // Reconcile claims already held by this wallet before claiming new work.
    const tasks = [];
    for (const id of ids) tasks.push({ id, task: await getCachedTask(client, config, this.state, id) });
    tasks.sort((a, b) => Number(b.task.worker.toLowerCase() === account.address.toLowerCase() && b.task.status === 1) - Number(a.task.worker.toLowerCase() === account.address.toLowerCase() && a.task.status === 1));
    for (const { id, task: initial } of tasks) {
      if (initial.status >= 3) continue;
      if (initial.status === 0 && policy.acceptNewTasks === false) continue;
      const retryKey = `worker-retry:${this.scope(id)}:${initial.attempt}`;
      if ((this.state.get<{ nextAt: number }>(retryKey)?.nextAt ?? 0) > Date.now()) continue;
      try {
      const now = (await client.getBlock()).timestamp; let task = initial;
      if (task.status === 2 && task.worker.toLowerCase() === account.address.toLowerCase() && now >= task.reviewDeadline) {
        await this.signer.write(config.manager, taskManagerAbi, 'finalize', [id], `finalize:${id}:${task.attempt}`); this.log({ event: 'timeout-settlement', taskId: id.toString() }); continue;
      }
      if (task.status === 1 && task.worker.toLowerCase() === account.address.toLowerCase() && now >= task.claimLeaseExpiresAt) {
        await this.signer.write(config.manager, taskManagerAbi, 'releaseExpiredClaim', [id], `release:${id}:${task.attempt}`); continue;
      }
      if (task.status !== 0 && !(task.status === 1 && task.worker.toLowerCase() === account.address.toLowerCase())) continue;
      if (now >= task.taskDeadline) continue;
      if (this.state.get(`skip:${this.scope(id)}`)) continue;
      if (!this.handlers.some(h => capabilityId(h.capability, '1.0.0') === task.capabilityId)) continue;
      const spec = validateTaskSpec(await this.storage.get(task.specURI, task.specHash));
      const requestId = spec.clientRequestId;
      assertTaskSpecBinding(spec, { settlementChainId: String(config.chainId), taskManager: config.manager.toLowerCase(), requester: task.requester.toLowerCase(), clientRequestId: requestId, settlementToken: config.token.toLowerCase(), params: task });
      const mapped = await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getTaskByRequestId', args: [task.requester, requestId as Hex] });
      if (mapped !== id) throw new Error('REQUEST_ID_BINDING_MISMATCH');
      const handler = this.handlers.find(h => h.capability === spec.capability && spec.capabilityVersion === '1.0.0');
      if (!handler || task.rewardAmount < 1000n || handler.accepts && !handler.accepts(spec)) continue;
      if (task.status === 0) {
        if (this.state.list(`job:${this.scope(id)}:`).some(entry => (entry.value as { submitted?: boolean }).submitted)) { this.state.set(`skip:${this.scope(id)}`, 'previous-result-rejected'); continue; }
        if (task.taskDeadline - now < 45n || task.claimLeaseSeconds < 45) continue;
        try { await this.signer.write(config.manager, taskManagerAbi, 'claimTask', [id], `claim:${id}:${task.attempt + 1n}`); }
        catch (error) { this.log({ event: 'claim-unavailable', taskId: id.toString(), error: String(error).slice(0, 200) }); continue; }
        task = await getTask(client, config, id);
        if (task.status !== 1 || task.worker.toLowerCase() !== account.address.toLowerCase()) continue;
      }
      const jobKey = `job:${this.scope(id)}:${task.attempt}`;
      let job = this.state.get<{ hash: Hex; uri: string; submitted?: boolean }>(jobKey);
      if (!job) {
        const seconds = Number(task.claimLeaseExpiresAt - (await client.getBlock()).timestamp) - 30;
        if (seconds <= 0) continue;
        this.log({ event: 'executing', taskId: id.toString(), attempt: task.attempt.toString(), capability: spec.capability });
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error('LEASE_EXECUTION_TIMEOUT')), seconds * 1000);
        try {
          const execution = await handler.execute(spec, { signal: controller.signal, client, chainId: config.chainId });
          controller.signal.throwIfAborted();
          const schema = await checkOutputSchema(spec.outputSchema, execution.output);
          if (!schema.passed) throw new Error(`WORKER_OUTPUT_INVALID: ${schema.detail}`);
          const result = validateResultManifest({ protocol: 'agent-task/0.1', settlementChainId: String(config.chainId), taskManager: config.manager.toLowerCase(), taskId: id.toString(), attempt: task.attempt.toString(), worker: account.address.toLowerCase(), specHash: task.specHash, output: execution.output, artifacts: [], provenance: execution.provenance });
          job = await this.storage.put(result); this.state.set(jobKey, job);
        } finally { clearTimeout(timer); }
      }
      const fresh = await getTask(client, config, id);
      if (fresh.status !== 1 || fresh.attempt !== task.attempt || fresh.worker.toLowerCase() !== account.address.toLowerCase()) continue;
      await this.signer.write(config.manager, taskManagerAbi, 'submitResult', [id, task.attempt, job.hash, job.uri], `submit:${id}:${task.attempt}`);
      this.state.set(jobKey, { ...job, submitted: true }); this.log({ event: 'submitted', taskId: id.toString(), resultHash: job.hash });
      return; // Capacity is one execution at a time per process.
      } catch (error) {
        this.state.set(retryKey, { nextAt: Date.now() + 10000 });
        this.log({ event: 'task-error', taskId: id.toString(), error: String(error).slice(0, 500) });
      }
    }
  }
}
