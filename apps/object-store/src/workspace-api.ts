import { commandSchema, equalSecret, sessionCookie, validSession } from '@agent-task/workspace';
import type { Env } from './index.js';

async function body(request: Request, limit = 16384) {
  if (!request.body) throw new Error('EMPTY_BODY'); const reader = request.body.getReader(); let text = ''; let count = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; count += chunk.value.length; if (count > limit) { await reader.cancel(); throw new Error('BODY_LIMIT'); } text += decoder.decode(chunk.value, { stream: true }); } text += decoder.decode(); return JSON.parse(text); }
  finally { reader.releaseLock(); }
}
export async function workspaceApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  const reply = (data: unknown, code = 200) => new Response(JSON.stringify(data), { status: code, headers });
  if (!env.DB) return reply({ error: '工作区存储尚未配置。' }, 503);
  const db = env.DB;
  try {
    if (url.pathname.startsWith('/bridge/')) {
      if (!env.STORAGE_UPLOAD_TOKEN || !await equalSecret(request.headers.get('authorization') ?? '', `Bearer ${env.STORAGE_UPLOAD_TOKEN}`)) return reply({ error: 'UNAUTHORIZED' }, 401);
      if (url.pathname === '/bridge/workspace' && request.method === 'PUT') {
        const snapshot = await body(request, 512 * 1024);
        if (!Array.isArray(snapshot.goals) || !Array.isArray(snapshot.workers) || snapshot.config?.chainId !== 10143) return reply({ error: 'INVALID_SNAPSHOT' }, 400);
        const version = Date.parse(snapshot.updatedAt ?? '') || Date.now();
        await db.prepare("INSERT INTO workspace_state(id, body, updated_at) VALUES ('current', ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at WHERE excluded.updated_at>=workspace_state.updated_at").bind(JSON.stringify(snapshot), version).run();
        return reply({ ok: true });
      }
      if (url.pathname === '/bridge/commands' && request.method === 'GET') {
        const row = await db.prepare("SELECT payload FROM workspace_commands WHERE status='queued' ORDER BY created_at LIMIT 1").first<{ payload: string }>();
        return reply({ command: row ? JSON.parse(row.payload) : null });
      }
      const match = /^\/bridge\/commands\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (match && request.method === 'PUT') {
        const result = await body(request, 256 * 1024);
        if (!['complete', 'failed'].includes(result.status)) return reply({ error: 'INVALID_RESULT' }, 400);
        await db.prepare("UPDATE workspace_commands SET status=?, result=? WHERE id=? AND status='queued'").bind(result.status, JSON.stringify(result), match[1]).run();
        return reply({ ok: true });
      }
      return reply({ error: 'NOT_FOUND' }, 404);
    }
    if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) return reply({ error: '请求来源不匹配，请在工作区页面操作。' }, 403);
    const authenticated = await validSession(request.headers.get('cookie'), env.WORKSPACE_ACCESS_CODE, url.origin);
    if (url.pathname === '/workspace/session' && request.method === 'GET') return reply({ authenticated, available: Boolean(env.WORKSPACE_ACCESS_CODE) });
    if (url.pathname === '/workspace/session' && request.method === 'POST') {
      const data = await body(request, 4096);
      if (!env.WORKSPACE_ACCESS_CODE || !await equalSecret(String(data.code ?? ''), env.WORKSPACE_ACCESS_CODE)) return reply({ error: '访问码不正确，请使用当前工作区的访问码。' }, 401);
      headers.set('set-cookie', await sessionCookie(env.WORKSPACE_ACCESS_CODE, url.origin)); return reply({ authenticated: true });
    }
    if (!authenticated) return reply({ error: '请先连接工作区。' }, 401);
    if (url.pathname === '/workspace/logout' && request.method === 'POST') { headers.set('set-cookie', 'worknet_session=; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0'); return reply({ ok: true }); }
    if (url.pathname === '/workspace/state' && request.method === 'GET') {
      const row = await db.prepare("SELECT body, updated_at FROM workspace_state WHERE id='current'").first<{ body: string; updated_at: number }>();
      if (!row) return reply({ error: '执行服务尚未连接。请启动本机工作区服务。' }, 503);
      const snapshot = JSON.parse(row.body); const connected = Date.now() - row.updated_at < 30000;
      return reply({ ...snapshot, workers: snapshot.workers.map((worker: { online: boolean; updatedAt: string }) => ({ ...worker, online: connected && worker.online && Date.now() - Date.parse(worker.updatedAt) < 15000 })), connected, syncedAt: row.updated_at });
    }
    if (url.pathname === '/workspace/commands' && request.method === 'POST') {
      const command = commandSchema.parse(await body(request)); const payload = JSON.stringify(command);
      const existing = await db.prepare('SELECT payload,status,result,created_at FROM workspace_commands WHERE id=?').bind(command.id).first<{ payload: string; status: string; result: string | null; created_at: number }>();
      if (existing) { if (existing.payload !== payload) return reply({ error: '操作编号已用于不同内容。' }, 409); return reply({ id: command.id, status: existing.status, ...(existing.result ? JSON.parse(existing.result) : {}), createdAt: existing.created_at }); }
      const live = await db.prepare("SELECT updated_at FROM workspace_state WHERE id='current'").first<{ updated_at: number }>();
      if (!live || Date.now() - live.updated_at > 30000) return reply({ error: '本机执行服务已离线。重新连接后即可继续，目标内容已保留。' }, 503);
      const queue = await db.prepare("SELECT count(*) AS n FROM workspace_commands WHERE status='queued'").first<{ n: number }>();
      if (queue && queue.n >= 16) return reply({ error: '正在处理的操作较多，请稍后重试。' }, 429);
      const createdAt = Date.now();
      await db.prepare("INSERT OR IGNORE INTO workspace_commands(id,payload,status,created_at) VALUES (?,?,'queued',?)").bind(command.id, payload, createdAt).run();
      const inserted = await db.prepare('SELECT payload FROM workspace_commands WHERE id=?').bind(command.id).first<{ payload: string }>();
      if (inserted?.payload !== payload) return reply({ error: '操作编号已用于不同内容。' }, 409);
      return reply({ id: command.id, status: 'queued', createdAt }, 202);
    }
    const match = /^\/workspace\/commands\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (match && request.method === 'GET') {
      const row = await db.prepare('SELECT status,result,created_at FROM workspace_commands WHERE id=?').bind(match[1]).first<{ status: string; result: string | null; created_at: number }>();
      if (!row) return reply({ error: '找不到该操作。' }, 404);
      return reply({ id: match[1], status: row.status, ...(row.result ? JSON.parse(row.result) : {}), createdAt: row.created_at });
    }
    return reply({ error: 'NOT_FOUND' }, 404);
  } catch { return reply({ error: '请求内容不完整或超过限制，请检查后重试。' }, 400); }
}
