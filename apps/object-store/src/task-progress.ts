import { z } from 'zod';
import type { Env } from './index.js';
import type { RunRow } from './taker-api.js';

export const progressSchema = z.object({
  id: z.string().uuid(),
  summary: z.string().trim().min(1).max(1000),
  percent: z.number().int().min(0).max(100).optional(),
}).strict();

export type ProgressUpdate = {
  id: string; summary: string; percent: number | null; createdAt: number;
};

/** The caller checks the finalized claim; the insert rechecks mutable run authority atomically. */
export async function saveProgress(env: Env, run: RunRow, input: z.infer<typeof progressSchema>) {
  const now = Date.now();
  await env.DB!.prepare(`INSERT OR IGNORE INTO platform_run_progress(run_id,id,summary,percent,created_at)
    SELECT id,?,?,?,? FROM platform_runs WHERE id=? AND owner=? AND executor_id IS ?
    AND revoked=0 AND result_hash IS NULL AND json_extract(body,'$.authorized')=1
    AND json_extract(body,'$.validUntil')>?
    AND (executor_id IS NULL OR EXISTS (SELECT 1 FROM platform_executors e
      WHERE e.id=platform_runs.executor_id AND e.owner=platform_runs.owner
      AND e.approved=1 AND e.revoked=0 AND e.expires_at>?))`)
    .bind(input.id, input.summary, input.percent ?? null, now, run.id, run.owner, run.executor_id, now / 1000, now).run();
  const saved = await env.DB!.prepare('SELECT id,summary,percent,created_at AS createdAt FROM platform_run_progress WHERE run_id=? AND id=?')
    .bind(run.id, input.id).first<ProgressUpdate>();
  if (!saved) throw new Error('GRANT_EXPIRED');
  if (saved.summary !== input.summary || saved.percent !== (input.percent ?? null)) throw new Error('PROGRESS_CONFLICT');
  return saved;
}

export async function runProgress(env: Env, runId: string) {
  const row = await env.DB!.prepare(`SELECT json_group_array(json(item)) items FROM (
    SELECT json_object('id',id,'summary',summary,'percent',percent,'createdAt',created_at) item
    FROM platform_run_progress WHERE run_id=? ORDER BY sequence DESC LIMIT 20)`)
    .bind(runId).first<{ items: string }>();
  return JSON.parse(row?.items ?? '[]') as ProgressUpdate[];
}

/** One bounded query for the requester list; never expose reports in public market responses. */
export async function attachGoalProgress(env: Env, owner: string, goals: { id: string; progress?: ProgressUpdate[] }[]) {
  if (!goals.length) return;
  const row = await env.DB!.prepare(`SELECT json_group_array(json(item)) items FROM (
    SELECT json_object('goalId',goal_id,'id',id,'summary',summary,'percent',percent,'createdAt',created_at) item FROM (
      SELECT g.id goal_id,p.*,row_number() OVER (PARTITION BY g.id ORDER BY p.sequence DESC) position
      FROM platform_goals g JOIN platform_runs r ON r.task_id=json_extract(g.body,'$.taskId')
        AND r.attempt=CAST(json_extract(g.body,'$.task.attempt') AS TEXT)
        AND r.owner=lower(json_extract(g.body,'$.task.worker'))
      JOIN platform_run_progress p ON p.run_id=r.id
      WHERE g.owner=? AND g.id IN (${goals.map(() => '?').join(',')})
        AND json_extract(g.body,'$.task.status')<>0
    ) WHERE position<=20 ORDER BY sequence DESC)`)
    .bind(owner, ...goals.map(g => g.id)).first<{ items: string }>();
  const updates = JSON.parse(row?.items ?? '[]') as (ProgressUpdate & { goalId: string })[];
  for (const goal of goals) goal.progress = updates.filter(p => p.goalId === goal.id).map(({ goalId: _, ...p }) => p);
}
