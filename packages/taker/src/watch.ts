import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { TakerApiError, type TakerClient, type AssignmentBatch } from './client.js';

type RunClient = Pick<TakerClient, 'run' | 'claim' | 'waitClaim' | 'analyze' | 'upload' | 'submit'> & Partial<Pick<TakerClient,'purchaseTransfers' | 'progress'>>;
export type RunOutcome = { state: 'finished' | 'inactive' | 'handler-required' | 'wallet-required' | 'submitted' | 'attention'; detail?: unknown };

/** Reused by one-shot run and watch; always recheck the chain before doing work. */
export async function executeRun(client: RunClient, runId: string, directory: string, options: {paidTools?:boolean} = {}): Promise<RunOutcome> {
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error('Invalid run ID');
  let run = await client.run(runId);
  if (run.revoked || !run.authorized || run.validUntil * 1000 <= Date.now() || run.superseded) return { state: 'inactive' };
  if (Number(run.task.status) >= 2) return { state: 'finished', detail: run };
  // Do not spend a claim/lease on a capability this built-in runner cannot execute.
  if (!run.resultHash && run.spec.capability !== 'analysis.token-transfers') return { state: 'handler-required' };
  if (Number(run.task.status) === 0) {
    if (BigInt(run.task.attempt) + 1n !== BigInt(run.attempt)) return { state: 'inactive' };
    const claim = await client.claim(runId);
    if (claim.walletRequired) return { state: 'wallet-required', detail: claim };
    if (claim.status === 'failed') return { state: 'attention', detail: claim };
    run = await client.waitClaim(runId);
  }
  if (Number(run.task.status) >= 2) return { state: 'finished', detail: run };
  if (Number(run.task.status) !== 1 || run.task.worker.toLowerCase() !== run.owner.toLowerCase() || String(run.task.attempt) !== run.attempt || Number(run.task.claimLeaseExpiresAt) * 1000 <= Date.now()) return { state: 'inactive' };
  // Reporting is best-effort: a transient progress-service failure must not prevent delivery.
  const report = async (id: string, summary: string, percent?: number) => {
    try { await client.progress?.(runId, { id, summary, ...(percent === undefined ? {} : {percent}) }); }
    catch (error) { console.warn(`Progress report failed for ${runId}: ${String(error)}`); }
  };
  if (!run.resultHash) {
    await report('00000000-0000-4000-8000-000000000001', '已确认领取，正在查询并核对指定区块范围内的转账记录。');
    const filename = join(directory, `execution-${runId}${options.paidTools?'-mpp':''}.json`);
    let execution: unknown;
    try { execution = JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (options.paidTools && !client.purchaseTransfers) throw new Error('Paid tool client unavailable');
      execution = options.paidTools ? await client.purchaseTransfers!(runId) : await client.analyze(runId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(filename, JSON.stringify(execution), { mode: 0o600, flag: 'wx' });
    }
    await report('00000000-0000-4000-8000-000000000002', '转账分析已完成，正在上传交付结果，随后提交独立审核。', 100);
    await client.upload(runId, execution);
  }
  const submitted = await client.submit(runId);
  return { state: submitted.walletRequired ? 'wallet-required' : submitted.status === 'failed' ? 'attention' : 'submitted', detail: submitted };
}

export type WatchEvent = { event: string; runId?: string; state?: string; error?: string; retryInMs?: number };
export function fatalAuthentication(error: unknown) {
  return error instanceof TakerApiError && (error.status === 401 || error.code === 'EXECUTOR_REVOKED' || error.code === 'APPROVAL_REQUIRED');
}

/** Serial execution, no model calls while idle, bounded retry after network failures. */
export async function watchAssignments(options: {
  wait: (cursor?: string) => Promise<AssignmentBatch>;
  execute: (runId: string) => Promise<RunOutcome>;
  signal: AbortSignal;
  log: (event: WatchEvent) => void;
}) {
  const { signal, log } = options;
  let cursor: string | undefined, failures = 0;
  const seen = new Map<string, { version: string; retryAt: number; state: string; failures: number }>();
  log({ event: 'watching' });
  while (!signal.aborted) {
    try {
      const batch = await options.wait(cursor);
      if (signal.aborted) break;
      cursor = batch.cursor; failures = 0;
      const currentIds = new Set(batch.runs.map(run => run.id));
      for (const id of seen.keys()) if (!currentIds.has(id)) seen.delete(id);
      for (const run of batch.runs) {
        if (signal.aborted) break;
        const previous = seen.get(run.id);
        if (previous?.version === run.version && previous.retryAt > Date.now()) continue;
        // Queued submissions are recovered by the platform outbox, not sent again here.
        if (run.submitStatus && run.submitStatus !== 'failed' || run.taskStatus !== null && run.taskStatus >= 2) continue;
        if (run.claimStatus === 'failed' || run.submitStatus === 'failed') {
          seen.set(run.id, {version: run.version, retryAt: Infinity, state: 'attention', failures: 0});
          if (previous?.state !== 'attention') log({event: 'run', runId: run.id, state: 'attention'});
          continue;
        }
        try {
          const result = await options.execute(run.id);
          if (signal.aborted) break;
          const retryAt = result.state === 'wallet-required' ? Date.now()+30000 : Infinity;
          seen.set(run.id, {version: run.version, retryAt, state: result.state, failures: 0});
          if (previous?.state !== result.state) log({event: 'run', runId: run.id, state: result.state});
        } catch (error) {
          if (signal.aborted) break;
          if (fatalAuthentication(error)) throw error;
          const attempts = (previous?.failures ?? 0) + 1;
          const retryInMs = Math.min(300000, 30000 * 2 ** Math.min(attempts-1, 4));
          seen.set(run.id, {version: run.version, retryAt: Date.now()+retryInMs, state: 'retry', failures: attempts});
          log({event: 'run-error', runId: run.id, error: String(error), retryInMs});
        }
      }
    } catch (error) {
      if (signal.aborted) break;
      if (fatalAuthentication(error)) throw error;
      const retryInMs = Math.min(60000, 2000 * 2 ** Math.min(failures++, 5));
      log({event: 'connection-retry', error: String(error), retryInMs});
      try { await sleep(retryInMs, undefined, {signal}); } catch { if (!signal.aborted) throw error; }
    }
  }
  log({event: 'stopped'});
}
