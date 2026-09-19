import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { erc20Abi, type Address } from 'viem';
import { hashJson, validateTaskSpec, type TaskSpec } from '@agent-task/protocol';
import { commandSchema, type GoalRecord, type GoalView, type WorkspaceCommand, type WorkspaceSnapshot, type WorkerView } from '@agent-task/workspace';
import { Requester, transferTask } from './requester.js';
import { researchTask } from './research.js';
import { getCachedTask, scanTasks } from './chain.js';
import { setWorkerAccepting, workerAccepting, type WorkerReport } from './worker-control.js';
import { type Evidence } from './verification.js';

export class WorkspaceError extends Error {}
const defaults = ['https://docs.monad.xyz/guides/erc-8004.md', 'https://docs.monad.xyz/reference/mpp/overview.md'];
export class Workspace {
  private tail: Promise<unknown> = Promise.resolve();
  private cachedWorkers: { until: number; value: WorkerView[] } | undefined;
  constructor(readonly requester: Requester, readonly configFile: string, readonly modelAvailable: boolean) {}
  get directory() { return path.dirname(this.configFile); }
  run(input: unknown): Promise<unknown> {
    const command = commandSchema.parse(input);
    const work = this.tail.then(() => this.execute(command)); this.tail = work.catch(() => undefined); return work;
  }
  private async execute(command: WorkspaceCommand) {
    const { state } = this.requester;
    const key = `workspace-command:${command.id}`; const fingerprint = hashJson(command);
    const prior = state.get<{ fingerprint: string; result: unknown }>(key);
    if (prior) { if (prior.fingerprint !== fingerprint) throw new WorkspaceError('同一操作编号不能用于不同内容。'); return prior.result; }
    let result: unknown;
    if (command.type === 'plan') {
      const input = command.input;
      if (input.kind !== 'analysis' && !this.modelAvailable) throw new WorkspaceError('研究 Agent 的模型尚未连接，请先启动模型服务。');
      const urls = input.sourceUrls.length ? input.sourceUrls : defaults;
      if (input.kind !== 'analysis') for (const uri of urls) {
        const u = new URL(uri);
        if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.port && u.port !== '443' || !u.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) throw new WorkspaceError('资料地址必须是公共 HTTPS 网页，不能包含凭证或内网地址。');
      }
      if (input.fromBlock && input.toBlock && (BigInt(input.fromBlock) > BigInt(input.toBlock) || BigInt(input.toBlock) - BigInt(input.fromBlock) > 1000n)) throw new WorkspaceError('分析区间最多 1,001 个区块，起点不能晚于终点。');
      const tasks: GoalRecord['tasks'] = [];
      if (input.kind !== 'analysis') tasks.push({ kind: 'research', title: '研究资料并形成结论', description: `阅读 ${urls.length} 份指定资料，提交有原文引用的研究简报，并进行独立审核。`, reward: '50000' });
      if (input.kind !== 'research') tasks.push({ kind: 'analysis', title: '复算链上转账记录', description: '统计测试 USDC 在指定区间内的转账事件与金额，独立复算后交付。', reward: '50000' });
      const goal: GoalRecord = { id: command.id, title: input.goal.replace(/\s+/g, ' ').slice(0, 72), input: { ...input, sourceUrls: input.kind === 'analysis' ? [] : urls }, createdAt: new Date().toISOString(), tasks, status: 'draft' };
      state.set(`workspace-goal:${goal.id}`, goal); result = goal;
    } else if (command.type === 'launch') {
      const goal = state.get<GoalRecord>(`workspace-goal:${command.goalId}`); if (!goal) throw new WorkspaceError('找不到这份计划，请重新生成。');
      if (goal.status === 'completed' || goal.tasks.every(t => t.taskId)) result = goal;
      else {
        const { config, client } = this.requester.signer;
        const budget = await this.requester.budget();
        const needed = goal.tasks.filter(t => !t.taskId).reduce((n, task) => n + BigInt(task.reward), 0n);
        if (!budget.effectiveActive || budget.newCommitmentCapacity < needed) throw new WorkspaceError('工作区可用预算不足或授权已到期，请在预算设置中检查。');
        const now = Number((await client.getBlock()).timestamp);
        if (!goal.tasks.every(t => t.spec)) {
          const head = await client.getBlock({ blockTag: config.finality });
          const toBlock = goal.input.toBlock ?? head.number.toString(); const fromBlock = goal.input.fromBlock ?? (BigInt(toBlock) > 99n ? BigInt(toBlock) - 99n : 0n).toString();
          if (BigInt(toBlock) > head.number || BigInt(fromBlock) > BigInt(toBlock) || BigInt(toBlock) - BigInt(fromBlock) > 1000n) throw new WorkspaceError('请选择已确认且不超过 1,001 个区块的分析范围。');
          for (const task of goal.tasks) {
            const spec = task.kind === 'analysis'
              ? transferTask(config, `workspace/${goal.id}/analysis`, now + 900, { token: config.token, fromBlock, toBlock })
              : researchTask(config, `workspace/${goal.id}/research`, now + 900, 'llm');
            spec.title = goal.title;
            if (task.kind === 'research') {
              spec.instructions = `完成以下研究目标：${goal.input.goal}\n仅依据指定公开资料形成结论，每项论点必须有准确原文引用。资料不足时明确写出局限，不臆造。`;
              spec.input = { mode: 'llm', sourceUrls: goal.input.sourceUrls };
              (spec.outputSchema as { properties: { findings: { minItems: number } } }).properties.findings.minItems = goal.input.sourceUrls.length;
              spec.verification.criteria = ['回应承诺的研究目标，资料不足时明确说明局限', '每项论点有来自指定资料的准确原文引文，不得编造'];
              // The authenticated workspace operator explicitly chose these sources.
              // Workers still validate every resolved public IP and redirect.
              const hosts = [...new Set([...config.sourceHosts, ...goal.input.sourceUrls.map(u => new URL(u).hostname)])];
              const raw = JSON.parse(await readFile(this.configFile, 'utf8')); raw.sourceHosts = hosts;
              await writeFile(this.configFile + '.tmp', JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 }); await rename(this.configFile + '.tmp', this.configFile);
              config.sourceHosts.splice(0, config.sourceHosts.length, ...hosts);
            }
            task.spec = validateTaskSpec(spec);
          }
          goal.launchedAt = new Date().toISOString(); goal.status = 'launching'; state.set(`workspace-goal:${goal.id}`, goal);
        }
        try {
          for (const task of goal.tasks) {
            if (!task.taskId) { task.taskId = (await this.requester.hire(task.spec as TaskSpec)).taskId.toString(); state.set(`workspace-goal:${goal.id}`, goal); }
          }
          goal.status = 'running'; delete goal.error;
        } catch (error) {
          goal.status = 'attention'; goal.error = '发布尚未完成。继续执行会恢复原请求，不会重复创建已发布任务。'; state.set(`workspace-goal:${goal.id}`, goal); throw error;
        }
        state.set(`workspace-goal:${goal.id}`, goal); result = goal;
      }
    } else {
      const reports = await this.reports();
      if (!reports.some(r => r.address.toLowerCase() === command.address.toLowerCase())) throw new WorkspaceError('这个 Worker 尚未连接到当前工作区。');
      await setWorkerAccepting(this.directory, command.address, command.accepting); this.cachedWorkers = undefined;
      result = { address: command.address, accepting: command.accepting };
    }
    state.set(key, { fingerprint, result }); return result;
  }
  private async reports(): Promise<WorkerReport[]> {
    const dir = path.join(this.directory, 'workers');
    const files = await readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    return Promise.all(files.filter(f => /^0x[0-9a-f]{40}\.json$/.test(f)).map(async f => JSON.parse(await readFile(path.join(dir, f), 'utf8')) as WorkerReport));
  }
  snapshot(publicConfig: unknown): Promise<WorkspaceSnapshot> {
    const work = this.tail.then(() => this.buildSnapshot(publicConfig));
    this.tail = work.catch(() => undefined); return work;
  }
  private async buildSnapshot(publicConfig: unknown): Promise<WorkspaceSnapshot> {
    const { signer, state, storage } = this.requester; const { client, config } = signer;
    const ids = await scanTasks(client, config, state);
    const tasks = new Map(await Promise.all(ids.map(async id => [id.toString(), await getCachedTask(client, config, state, id)] as const)));
    const events = state.db.prepare('SELECT data FROM events ORDER BY rowid').all().map(r => JSON.parse(String(r.data)));
    const goals: GoalView[] = [];
    for (const { value: goal } of state.list<GoalRecord>('workspace-goal:').sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt)).slice(0, 40)) {
      const view: GoalView = { ...goal, tasks: [] };
      for (const planned of goal.tasks) {
        const task = planned.taskId && tasks.get(planned.taskId);
        if (!task) { view.tasks.push(planned); continue; }
        const verification = state.list<Evidence>(`verification:${config.chainId}:${config.manager}:${planned.taskId}:`).map(r => r.value);
        let result: unknown;
        if (task.status === 2 || task.status === 3) {
          const key = `workspace-result:${task.resultHash}`; result = state.get(key);
          if (!result) { try { result = await storage.get(task.resultURI, task.resultHash); state.set(key, result); } catch { /* Surface missing result without inventing content. */ } }
        }
        view.tasks.push({ ...planned, status: task.status, worker: task.worker, attempt: task.attempt.toString(), resultHash: task.resultHash, result, verification, events: events.filter(e => e.args.taskId === planned.taskId) });
      }
      if (goal.launchedAt) {
        if (view.tasks.every(t => t.status === 3 && t.verification?.some(e => e.attempt === t.attempt && e.resultHash === t.resultHash && e.verdict === 'accept'))) view.status = 'completed';
        else if (view.tasks.some(t => t.status === 4 || t.status === 5 || t.status === 3 && !t.verification?.some(e => e.attempt === t.attempt && e.resultHash === t.resultHash && e.verdict === 'accept'))) view.status = 'attention';
      }
      goals.push(view);
    }
    if (!this.cachedWorkers || this.cachedWorkers.until < Date.now()) {
      const workers: WorkerView[] = [];
      for (const report of await this.reports()) {
        const own = [...tasks.values()].filter(t => t.worker.toLowerCase() === report.address.toLowerCase());
        workers.push({ ...report, online: Date.now() - Date.parse(report.updatedAt) < 15000, accepting: await workerAccepting(this.directory, report.address), completed: own.filter(t => t.status === 3).length,
          earned: own.filter(t => t.status === 3).reduce((n, t) => n + t.rewardAmount, 0n).toString(), gasBalance: (await client.getBalance({ address: report.address as Address })).toString() });
      }
      this.cachedWorkers = { until: Date.now() + 5000, value: workers };
    }
    return { updatedAt: new Date().toISOString(), connected: true, goals, workers: this.cachedWorkers.value, modelAvailable: this.modelAvailable, sourceHosts: config.sourceHosts, budget: await this.requester.budget(), config: publicConfig };
  }
}
