import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { progressSchema, saveProgress, runProgress, attachGoalProgress, type ProgressUpdate } from '../apps/object-store/src/task-progress.js';
import type { Env } from '../apps/object-store/src/index.js';
import type { RunRow } from '../apps/object-store/src/taker-api.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('apps/object-store/platform-schema.sql', 'utf8'));
  const env = { DB: { prepare(sql: string) {
    let args: SQLInputValue[] = [];
    return { bind(...values: SQLInputValue[]) { args = values; return this; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async run() { return db.prepare(sql).run(...args); } };
  } } } as unknown as Env;
  const run: RunRow = { id: crypto.randomUUID(), owner: '0xabc', executor_id: crypto.randomUUID(), task_id: '1', attempt: '1',
    body: JSON.stringify({ authorized: true, validUntil: Date.now() / 1000 + 3600 }), result_hash: null, result_body: null, revoked: 0, created_at: Date.now() };
  db.prepare('INSERT INTO platform_executors(id,token_hash,name,owner,approved,expires_at,created_at) VALUES (?,?,?,?,1,?,0)')
    .run(run.executor_id, 'hash', 'Agent', run.owner, Date.now() + 3600_000);
  db.prepare('INSERT INTO platform_runs(id,owner,executor_id,task_id,attempt,body,created_at) VALUES (?,?,?,?,?,?,0)')
    .run(run.id, run.owner, run.executor_id, run.task_id, run.attempt, run.body);
  const goal = { id: 'goal', progress: [] as ProgressUpdate[] };
  db.prepare('INSERT INTO platform_goals(id,owner,body,updated_at) VALUES (?,?,?,0)')
    .run(goal.id, 'requester', JSON.stringify({ taskId: '1', task: { status: 1, attempt: '1', worker: '0xABC' } }));
  return { db, env, run, goal };
}

test('progress validates summaries and estimates without accepting extra state or timestamps', () => {
  const input = { id: crypto.randomUUID(), summary: '  Checking sources  ' };
  assert.equal(progressSchema.parse(input).summary, 'Checking sources');
  for (const extra of [{ summary: ' ' }, { summary: 'x'.repeat(1001) }, { percent: -1 }, { percent: 101 }, { percent: 1.5 }, { percent: '50' }, { createdAt: 1 }, { status: 'completed' }]) {
    assert.equal(progressSchema.safeParse({ ...input, ...extra }).success, false);
  }
  for (const percent of [0, 100]) assert.equal(progressSchema.parse({ ...input, percent }).percent, percent);
});

test('progress retries are idempotent, history is bounded and survives schema reapplication', async () => {
  const { db, env, run } = fixture();
  try {
    const input = { id: crypto.randomUUID(), summary: 'Started', percent: 0 };
    const first = await saveProgress(env, run, input);
    assert.deepEqual(await saveProgress(env, run, input), first);
    await assert.rejects(saveProgress(env, run, { ...input, percent: 10 }), /PROGRESS_CONFLICT/);
    assert.equal((await runProgress(env, run.id)).length, 1);
    for (let i = 1; i <= 25; i++) await saveProgress(env, run, { id: crypto.randomUUID(), summary: `Step ${i}` });
    db.exec(readFileSync('apps/object-store/platform-schema.sql', 'utf8'));
    const history = await runProgress(env, run.id);
    assert.equal(history.length, 20);
    assert.equal(history[0]!.summary, 'Step 25');
    assert.equal(history[0]!.percent, null, 'omitting percent must not invent an estimate');
    assert.equal(history[19]!.summary, 'Step 6');
  } finally { db.close(); }
});

test('requester reads are isolated by requester, actual worker and attempt', async () => {
  const { db, env, run, goal } = fixture();
  try {
    await saveProgress(env, run, { id: crypto.randomUUID(), summary: 'Private summary' });
    await attachGoalProgress(env, 'requester', [goal]);
    assert.equal(goal.progress[0]!.summary, 'Private summary');
    await attachGoalProgress(env, 'other-requester', [goal]);
    assert.deepEqual(goal.progress, []);
    for (const task of [{ status: 1, attempt: '2', worker: '0xabc' }, { status: 1, attempt: '1', worker: '0xdef' }, { status: 0, attempt: '1', worker: '0xabc' }]) {
      db.prepare('UPDATE platform_goals SET body=?').run(JSON.stringify({ taskId: '1', task }));
      await attachGoalProgress(env, 'requester', [goal]);
      assert.deepEqual(goal.progress, [], 'previous/losing attempt must not show as current progress');
    }
  } finally { db.close(); }
});

test('atomic writes reject authority changes, takeover, expiration and fixed results', async () => {
  for (const sql of [
    'UPDATE platform_runs SET revoked=1',
    'UPDATE platform_runs SET executor_id=NULL',
    "UPDATE platform_runs SET body=json_set(body,'$.authorized',0)",
    "UPDATE platform_runs SET body=json_set(body,'$.validUntil',0)",
    "UPDATE platform_runs SET result_hash='fixed'",
    'UPDATE platform_executors SET revoked=1',
    'UPDATE platform_executors SET expires_at=0',
    'UPDATE platform_executors SET approved=0',
  ]) {
    const { db, env, run } = fixture();
    try {
      db.exec(sql);
      await assert.rejects(saveProgress(env, run, { id: crypto.randomUUID(), summary: 'Late report' }), /GRANT_EXPIRED/, sql);
      assert.deepEqual(await runProgress(env, run.id), []);
    } finally { db.close(); }
  }
});
