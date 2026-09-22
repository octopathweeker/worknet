import { hashJson } from '@agent-task/protocol/json';
import type { Env } from './index.js';

/** Waiting never calls RPC, models, or the coordinator. Indexed chain state is only a hint. */
export async function assignmentSnapshot(env: Env, executorId: string, owner: string) {
  const row = await env.DB!.prepare(`SELECT (
    SELECT json_group_array(json(item)) FROM (
      SELECT json_object('id',r.id,'taskId',r.task_id,'attempt',r.attempt,
        'mode',json_extract(r.body,'$.mode'),'capability',json_extract(r.body,'$.spec.capability'),
        'validUntil',json_extract(r.body,'$.validUntil'),'resultHash',r.result_hash,
        'taskStatus',json_extract(g.body,'$.task.status'),'taskAttempt',json_extract(g.body,'$.task.attempt'),
        'worker',json_extract(g.body,'$.task.worker'),'lease',json_extract(g.body,'$.task.claimLeaseExpiresAt'),
        'claimStatus',c.status,'submitStatus',s.status) item
      FROM platform_runs r
      LEFT JOIN platform_goals g ON json_extract(g.body,'$.taskId')=r.task_id
      LEFT JOIN platform_commands c ON c.id=r.id||':claim' AND c.owner=r.owner
      LEFT JOIN platform_commands s ON s.id=r.id||':submit' AND s.owner=r.owner
      WHERE r.executor_id=e.id AND r.owner=e.owner AND r.revoked=0
        AND json_extract(r.body,'$.authorized')=1 AND json_extract(r.body,'$.validUntil')>?
        AND (json_extract(g.body,'$.task.status') IS NULL OR json_extract(g.body,'$.task.status')<2)
        AND (s.status IS NULL OR s.status='failed')
      ORDER BY r.created_at,r.id LIMIT 60
    )
  ) items FROM platform_executors e
  WHERE e.id=? AND e.owner=? AND e.approved=1 AND e.revoked=0 AND e.expires_at>?`)
    .bind(Math.floor(Date.now()/1000), executorId, owner, Date.now()).first<{items: string}>();
  if (!row) throw new Error('EXECUTOR_REVOKED');
  const runs = JSON.parse(row.items ?? '[]') as Record<string, unknown>[];
  return { cursor: hashJson(runs), runs: runs.map((run): Record<string, unknown> & {version: string} => ({ ...run, version: hashJson(run) })) };
}

export function waitDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** A bounded long poll, with injectable timing for timeout/revocation tests. */
export async function waitForAssignments<T extends {cursor: string}>(
  snapshot: () => Promise<T>, cursor: string | undefined, signal: AbortSignal,
  options = { timeoutMs: 25000, intervalMs: 5000 },
): Promise<T & { timedOut: boolean }> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    const value = await snapshot();
    signal.throwIfAborted();
    if (value.cursor !== cursor) return { ...value, timedOut: false };
    if (Date.now() >= deadline) return { ...value, timedOut: true };
    await waitDelay(Math.min(options.intervalMs, deadline-Date.now()), signal);
  }
}
