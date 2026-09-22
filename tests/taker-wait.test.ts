import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { keccak256, stringToHex } from 'viem';
import { assignmentSnapshot, waitForAssignments } from '../apps/object-store/src/taker-wait.js';
import { takerApi } from '../apps/object-store/src/taker-api.js';
import type { Env } from '../apps/object-store/src/index.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('apps/object-store/platform-schema.sql', 'utf8'));
  const owner = `0x${'11'.repeat(20)}`, executor = crypto.randomUUID(), token = 'ab'.repeat(32);
  db.prepare('INSERT INTO platform_executors(id,token_hash,name,owner,approved,expires_at,created_at) VALUES (?,?,?,?,1,?,?)')
    .run(executor, keccak256(stringToHex(token)), 'demo', owner, Date.now()+60000, Date.now());
  const env: Env = { DB: { prepare(sql) { let args: SQLInputValue[] = []; return {
    bind(...values) { args = values as SQLInputValue[]; return this; },
    async first<T>() { return (db.prepare(sql).get(...args) ?? null) as T | null; },
    async run() { return db.prepare(sql).run(...args); },
  }; } }, PLATFORM: {} as any, PLATFORM_CONFIG: JSON.stringify({ chainId: 10143, manager: owner, factory: owner, operator: owner, sponsor: owner, worker: owner, rpcUrl: 'https://unused-rpc.test' }) };
  function run(id: string = crypto.randomUUID(), executorId: string = executor, authorized = true, taskId = id) {
    const body = JSON.stringify({authorized, validUntil:Math.floor(Date.now()/1000)+60, mode:'sponsored', spec:{capability:'analysis.token-transfers'}, claimPermission:{signature:'SECRET'}});
    db.prepare('INSERT INTO platform_runs(id,owner,executor_id,task_id,attempt,body,created_at) VALUES (?,?,?,?,?,?,?)').run(id,owner,executorId,taskId,'1',body,Date.now());
    return id;
  }
  return { db, env, owner, executor, token, run, snapshot: () => assignmentSnapshot(env,executor,owner) };
}

test('wait snapshots isolate executors, omit credentials, and observe authorization, chain and submission changes', async () => {
  const f = fixture();
  try {
    const empty = await f.snapshot();
    f.run(undefined, 'another-executor'); const run = f.run(undefined, undefined, false);
    assert.equal((await f.snapshot()).cursor,empty.cursor);
    f.db.prepare("UPDATE platform_runs SET body=json_set(body,'$.authorized',json('true')) WHERE id=?").run(run);
    const assigned = await f.snapshot();
    assert.equal(assigned.runs.length,1); assert.equal(assigned.runs[0]!.id,run); assert.notEqual(assigned.cursor,empty.cursor);
    assert(!JSON.stringify(assigned).includes('SECRET'));
    assert.equal((await f.snapshot()).cursor,assigned.cursor,'stable state must not spuriously wake clients');
    f.db.prepare('INSERT INTO platform_goals(id,owner,body,updated_at) VALUES (?,?,?,?)').run('goal',f.owner,JSON.stringify({taskId:run,task:{status:1,attempt:'1',worker:f.owner,claimLeaseExpiresAt:'12345'}}),Date.now());
    assert.notEqual((await f.snapshot()).cursor,assigned.cursor,'wallet claim must wake a waiting executor');
    f.db.prepare('INSERT INTO platform_commands(id,owner,type,fingerprint,payload,status,created_at) VALUES (?,?,?,?,?,?,?)').run(`${run}:submit`,f.owner,'taker-submit','hash','{}','queued',Date.now());
    assert.equal((await f.snapshot()).runs.length,0,'pending submission belongs to the existing outbox');
    f.db.prepare("UPDATE platform_commands SET status='failed'").run();
    assert.equal((await f.snapshot()).runs[0]!.submitStatus,'failed');
    f.db.prepare("UPDATE platform_goals SET body=json_set(body,'$.task.status',3)").run();
    assert.equal((await f.snapshot()).runs.length,0,'completed history must not crowd out new work');
    f.db.prepare("UPDATE platform_goals SET body=json_set(body,'$.task.status',1)").run();
    f.db.prepare('UPDATE platform_runs SET revoked=1 WHERE id=?').run(run);
    assert.equal((await f.snapshot()).runs.length,0);
  } finally { f.db.close(); }
});

test('long poll holds unchanged state, wakes on assignment, times out normally and cancels promptly', async () => {
  const controller = new AbortController(); let cursor = 'old', reads = 0;
  const snapshot = async () => { reads++; return {cursor}; };
  const waiting = waitForAssignments(snapshot,'old',controller.signal,{timeoutMs:200,intervalMs:10});
  const timer = setTimeout(() => { cursor='new'; },25);
  const changed = await waiting; clearTimeout(timer);
  assert.equal(changed.cursor,'new'); assert.equal(changed.timedOut,false); assert(reads>=2);
  const start = Date.now();
  assert.equal((await waitForAssignments(snapshot,'new',controller.signal,{timeoutMs:30,intervalMs:10})).timedOut,true);
  assert(Date.now()-start>=25);
  const canceled = waitForAssignments(snapshot,'new',controller.signal);
  controller.abort(new Error('stop'));
  await assert.rejects(canceled,/stop/);
});

test('revocation or expiry during a held request invalidates the next snapshot', async () => {
  for (const mutation of ['revoked=1','expires_at=0']) {
    const f=fixture();
    try {
      const first=await f.snapshot();
      const waiting=waitForAssignments(f.snapshot,first.cursor,new AbortController().signal,{timeoutMs:200,intervalMs:10});
      f.db.exec(`UPDATE platform_executors SET ${mutation}`);
      await assert.rejects(waiting,/EXECUTOR_REVOKED/);
    } finally {f.db.close();}
  }
});

test('wait API requires approved bearer authentication and performs no RPC/model requests', async () => {
  const f=fixture(); const original=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error('wait must not use network');};
  const call=(suffix='',token=f.token)=>takerApi(new Request(`https://platform.test/platform/taker/runs/wait${suffix}`,{headers:token?{authorization:`Bearer ${token}`}:{}}),f.env);
  try {
    assert.equal((await call('', '')).status,401);
    assert.equal((await call('?cursor=bad')).status,400);
    f.run(); const reply=await call(); assert.equal(reply.status,200);
    const body=await reply.json() as any; assert.equal(body.runs.length,1); assert.equal(body.timedOut,false);
    f.db.exec('UPDATE platform_executors SET approved=0'); assert.equal((await call()).status,403);
    f.db.exec('UPDATE platform_executors SET approved=1,expires_at=0'); assert.equal((await call()).status,401);
  } finally {globalThis.fetch=original;f.db.close();}
});
