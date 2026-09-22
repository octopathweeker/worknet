import { mppService } from './mpp-service.js';
import { internalModel } from './internal-model.js';
import { quicknodeWebhook } from './quicknode-webhook.js';
import { workspaceApi } from './workspace-api.js';
import { takerApi } from './taker-api.js';
import { platformApi } from './platform-api.js';
import type { DurableObjectNamespace, Ai } from '@cloudflare/workers-types';
export { ToolPayments } from './tool-payments.js';
export { HostedRunner } from './hosted-runner.js';
export { PlatformCoordinator } from './platform-coordinator.js';
import { hashJson, parseJsonBytes } from '@agent-task/protocol/json';
import { keccak256 } from 'viem';

// A narrow structural interface keeps the handler portable and avoids Node APIs.
export interface ObjectBucket {
  head(key: string): Promise<unknown | null>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null>;
  put(key: string, value: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
}
interface Statement { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; run(): Promise<unknown>; }
export interface Env { WORKNET_ENVIRONMENT?: string; WORKNET_PUBLIC_ORIGIN?: string; }
export interface Env { DELIVERY_REVIEW_KEY?: string; MPP_SERVICE_CONFIG?: string; MPP_SERVICE_SECRET?: string; ERC8004_CONFIG?: string; MPP_TOOL_CONFIG?: string; MPP_PAYER_KEY?: string; TOOL_PAYMENTS?: DurableObjectNamespace; MODEL_GATEWAY?: { fetch(request: Request): Promise<Response> } | undefined; MODEL_GATEWAY_TOKEN?: string; JUDGE_SERVICE_TOKEN?: string; JUDGE_1?: { fetch(request: Request): Promise<Response> }; JUDGE_2?: { fetch(request: Request): Promise<Response> }; JUDGE_3?: { fetch(request: Request): Promise<Response> }; OBJECTS?: ObjectBucket; DB?: { prepare(sql: string): Statement }; ASSETS?: { fetch(request: Request): Promise<Response> }; STORAGE_UPLOAD_TOKEN?: string; WORKSPACE_ACCESS_CODE?: string; PLATFORM?: DurableObjectNamespace; HOSTED?: DurableObjectNamespace; PLATFORM_CONFIG?: string; PLATFORM_OPERATOR_KEY?: string; PLATFORM_WORKER_KEY?: string; PLATFORM_SPONSOR_KEY?: string; PLATFORM_DAILY_GAS_LIMIT_MON?: string; AI?: Ai; PLATFORM_AI_MODEL?: string; PLATFORM_JUDGE_MODEL?: string; PLATFORM_GENERATION_PROVIDER?: string; OPENROUTER_API_KEY?: string; OPENROUTER_FREE_MODELS?: string; QUICKNODE_RPC_URL?: string; QUICKNODE_WEBHOOK_SECRET?: string; }
function bucketFor(env: Env): ObjectBucket {
  if (env.OBJECTS) return env.OBJECTS;
  const db = env.DB; if (!db) throw new Error('STORE_NOT_CONFIGURED');
  return {
    head(key) { return db.prepare('SELECT hash FROM objects WHERE hash = ?').bind(key).first(); },
    async get(key) {
      const row = await db.prepare('SELECT body FROM objects WHERE hash = ?').bind(key).first<{ body: string }>();
      return row ? { body: new Response(row.body).body! } : null;
    },
    put(key, bytes) { return db.prepare('INSERT OR IGNORE INTO objects(hash, body, created_at) VALUES (?, ?, ?)').bind(key, new TextDecoder().decode(bytes), Date.now()).run(); },
  };
}
const limit = 256 * 1024;
async function authorized(request: Request, token: string): Promise<boolean> {
  const actual = request.headers.get('authorization') ?? '';
  if (actual.length > 512) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(actual)), crypto.subtle.digest('SHA-256', enc.encode(`Bearer ${token}`))]);
  const left = new Uint8Array(a); const right = new Uint8Array(b); let different = 0;
  for (let i = 0; i < left.length; i++) different |= left[i]! ^ right[i]!;
  return different === 0;
}
async function bounded(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new Error('EMPTY_BODY');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) { await reader.cancel(); throw new Error('TOO_LARGE'); } chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  return bytes;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/services/')) return mppService(request, env);
    if (new URL(request.url).pathname.startsWith('/internal/')) return internalModel(request, env);
    if (new URL(request.url).pathname === '/webhooks/quicknode') return quicknodeWebhook(request, env);
    if (new URL(request.url).pathname.startsWith('/platform/taker/')) return takerApi(request, env);
    if (new URL(request.url).pathname.startsWith('/platform/')) return platformApi(request, env);
    if (/^\/(workspace|bridge)\//.test(new URL(request.url).pathname)) return workspaceApi(request, env);
    const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' });
    const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return respond({ service: 'worknet-object-store', ready: Boolean((env.OBJECTS || env.DB) && env.STORAGE_UPLOAD_TOKEN && env.STORAGE_UPLOAD_TOKEN.length >= 16) });
    if (url.pathname === '/dashboard' && request.method === 'PUT') {
      if (!env.DB || !env.STORAGE_UPLOAD_TOKEN || !await authorized(request, env.STORAGE_UPLOAD_TOKEN)) return respond({ error: 'UNAUTHORIZED' }, 401);
      try {
        const data = parseJsonBytes(await bounded(request)) as { schema?: string; config?: { mode?: string; chainId?: number }; tasks?: unknown[]; details?: unknown; budget?: unknown };
        const configKeys = new Set(['mode', 'chainId', 'manager', 'vault', 'token', 'owner', 'agent', 'llmAvailable', 'tokenLabel', 'rpcWalletUrl']);
        if (data.schema !== 'worknet-dashboard/1' || data.config?.mode !== 'testnet' || data.config.chainId !== 10143 || !Array.isArray(data.tasks) || !data.details || !data.budget || Object.keys(data.config).some(key => !configKeys.has(key))) return respond({ error: 'INVALID_SNAPSHOT' }, 400);
        await env.DB.prepare("INSERT INTO dashboard(id, body, updated_at) VALUES ('current', ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at").bind(JSON.stringify(data), Date.now()).run();
        return respond({ saved: true });
      } catch { return respond({ error: 'INVALID_SNAPSHOT' }, 400); }
    }
    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') return respond({ error: 'PUBLIC_API_IS_READ_ONLY' }, 405);
      const row = await env.DB?.prepare("SELECT body, updated_at FROM dashboard WHERE id = 'current'").first<{ body: string; updated_at: number }>();
      if (!row) return respond({ error: 'SNAPSHOT_NOT_READY' }, 503);
      const snapshot = JSON.parse(row.body);
      headers.set('cache-control', 'public, max-age=2');
      if (url.pathname === '/api/config') return respond({ ...snapshot.config, snapshotAt: row.updated_at, readOnlyApi: true });
      if (url.pathname === '/api/budget') return respond(snapshot.budget);
      if (url.pathname === '/api/tasks') return respond(snapshot.tasks);
      if (url.pathname === '/api/health') return respond({ ready: true, snapshotAt: row.updated_at });
      const task = /^\/api\/tasks\/([1-9][0-9]*)$/.exec(url.pathname);
      if (task && snapshot.details[task[1]!]) return respond(snapshot.details[task[1]!]);
      return respond({ error: 'NOT_FOUND' }, 404);
    }
    if (request.method === 'GET' && !url.pathname.startsWith('/objects/') && env.ASSETS) return env.ASSETS.fetch(request);
    const match = /^\/objects\/(0x[0-9a-f]{64})$/.exec(url.pathname);
    if (!match || url.search) return respond({ error: 'NOT_FOUND' }, 404);
    const hash = match[1]!;
    try {
      const bucket = bucketFor(env);
      if (request.method === 'PUT') {
        if (!env.STORAGE_UPLOAD_TOKEN || env.STORAGE_UPLOAD_TOKEN.length < 16) return respond({ error: 'UPLOAD_NOT_CONFIGURED' }, 503);
        if (!await authorized(request, env.STORAGE_UPLOAD_TOKEN)) return respond({ error: 'UNAUTHORIZED' }, 401);
        const bytes = await bounded(request);
        if (keccak256(bytes) !== hash || hashJson(parseJsonBytes(bytes)) !== hash) return respond({ error: 'INVALID_OBJECT' }, 400);
        // Any valid writer for this hash supplies identical canonical bytes. Concurrent
        // same-hash writes are therefore identical, and existing objects are left intact.
        if (!await bucket.head(hash)) await bucket.put(hash, bytes, { httpMetadata: { contentType: 'application/json' } });
        return respond({ hash }, 201);
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        const object = await bucket.get(hash);
        if (!object) return respond({ error: 'NOT_FOUND' }, 404);
        headers.set('cache-control', 'public, max-age=31536000, immutable');
        return new Response(request.method === 'HEAD' ? null : object.body, { headers });
      }
      return respond({ error: 'METHOD_NOT_ALLOWED' }, 405);
    } catch { return respond({ error: 'INVALID_OBJECT' }, 400); }
  },
};
