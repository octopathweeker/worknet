import { equalSecret, sessionCookie, validSession } from '@agent-task/workspace';
import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { mnemonicToAccount } from 'viem/accounts';
import { bytesToHex, type Hex } from 'viem';
import { requesterVaultAbi } from '@agent-task/contracts';
import { hashJson, parseJsonBytes, validateTaskSpec } from '@agent-task/protocol';
import { loadConfig, State, Signer, Requester, HttpStorage, Reviewer, configuredModel, researchVerifier, transferTask, researchTask, scanTasks, getTask, getCachedTask, checkChain, boundedBody, publicFailure, json, type Evidence, Workspace, WorkspaceError } from '@agent-task/runtime';

const filename = process.env.DEMO_CONFIG ?? '.runtime/config.json'; const config = loadConfig(filename); await checkChain(config);
const rawConfig = JSON.parse(await readFile(filename, 'utf8'));
const state = new State(path.join(path.dirname(filename), 'account-1.db'));
let key = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
if (config.mode === 'local-demo') key = bytesToHex(mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 1 }).getHdKey().privateKey!);
if (!key) throw new Error('AGENT_PRIVATE_KEY required');
const apiToken = process.env.REQUESTER_API_TOKEN;
if (!apiToken || apiToken.length < 24) throw new Error('REQUESTER_API_TOKEN (24+ chars) required');
const signer = new Signer(config, state, key); const storage = new HttpStorage(config.storageUrl, process.env.STORAGE_UPLOAD_TOKEN);
const requester = new Requester(signer, state, storage); const model = configuredModel();
const log = (value: unknown) => console.log(json(value));
const reviewer = new Reviewer(requester, researchVerifier(config.sourceHosts, model), log);
const port = Number(process.env.API_PORT ?? 8788);
const workspace = new Workspace(requester, filename, Boolean(model));
const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5173', 'http://localhost:5173', ...(process.env.UI_ORIGIN ? [process.env.UI_ORIGIN] : [])]);
const staticRoot = path.resolve('apps/explorer/dist');
let closing = false; let running = false;
async function update() {
  if (running || closing) return; running = true;
  try { await reviewer.tick(); state.set('runtime-health', { ok: true, updatedAt: new Date().toISOString() }); }
  catch (error) { log({ event: 'reviewer-error', detail: String(error).slice(0, 500) }); state.set('runtime-health', { ok: false, updatedAt: new Date().toISOString(), detail: publicFailure(error) }); }
  finally { running = false; }
}
const timer = setInterval(() => { void update(); }, 2500); void update();
const owner = await signer.client.readContract({ address: config.vault, abi: requesterVaultAbi, functionName: 'owner' });
const publicConfig = { mode: config.mode, chainId: config.chainId, manager: config.manager, vault: config.vault, token: config.token, owner, agent: signer.account.address, llmAvailable: Boolean(model), tokenLabel: config.mode === 'local-demo' ? 'dUSDC · 本地演示资产' : 'Test USDC · 测试资产', rpcWalletUrl: config.mode === 'local-demo' ? config.rpcUrl : 'https://testnet-rpc.monad.xyz' };
function auth(req: IncomingMessage): boolean { const actual = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${apiToken}`); return actual.length === expected.length && timingSafeEqual(actual, expected); }
const evidenceFor = (id: bigint) => state.list<Evidence>(`verification:${config.chainId}:${config.manager}:${id}:`).map(row => row.value);
async function listTasks() { const ids = await scanTasks(signer.client, config, state); const tasks = []; for (const id of ids) tasks.push({ taskId: id, ...await getCachedTask(signer.client, config, state, id), verification: evidenceFor(id) }); return tasks; }
async function preset(kind: 'transfer' | 'research', runKey: string, mode: 'extractive' | 'llm') {
  if (mode === 'llm' && !model) throw new Error('LLM_NOT_CONFIGURED');
  const id = `preset:${runKey}:${kind}`;
  const saved = state.get<ReturnType<typeof transferTask>>(id);
  if (saved && BigInt(saved.execution.taskDeadline) <= (await signer.client.getBlock()).timestamp) {
    const existing = await signer.client.readContract({ address: config.manager, abi: (await import('@agent-task/contracts')).taskManagerAbi, functionName: 'getTaskByRequestId', args: [config.vault, saved.clientRequestId as Hex] });
    if (existing === 0n) throw new Error('TASK_REQUEST_EXPIRED');
  }
  const spec = saved ?? (kind === 'transfer'
    ? transferTask(config, `${runKey}/transfer`, Number((await signer.client.getBlock()).timestamp) + 900, rawConfig.fixture)
    : researchTask(config, `${runKey}/research`, Number((await signer.client.getBlock()).timestamp) + 900, mode));
  state.set(id, spec); return requester.hire(spec);
}
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const origin = req.headers.origin;
  if (origin && !origins.has(origin)) { res.writeHead(403).end('Origin not allowed'); return; }
  const host = req.headers.host ?? '';
  if (![`127.0.0.1:${port}`, `localhost:${port}`, new URL(process.env.UI_ORIGIN ?? `http://127.0.0.1:${port}`).host].includes(host)) { res.writeHead(403).end('Host not allowed'); return; }
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-demo-action'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.writeHead(204).end(); return; }
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const respond = (value: unknown, code = 200) => { res.setHeader('content-type', 'application/json'); res.writeHead(code).end(json(value)); };
  try {
    if (url.pathname.startsWith('/workspace/') || url.pathname === '/api/workspace/command' || url.pathname === '/api/workspace/snapshot') {
      res.setHeader('cache-control', 'no-store');
      const sessionOrigin = `http://127.0.0.1:${port}`;
      const authenticated = auth(req) || await validSession(req.headers.cookie ?? null, process.env.WORKSPACE_ACCESS_CODE, sessionOrigin);
      if (url.pathname === '/workspace/session' && req.method === 'GET') { respond({ authenticated, available: Boolean(process.env.WORKSPACE_ACCESS_CODE) }); return; }
      if (url.pathname === '/workspace/session' && req.method === 'POST') {
        const body = parseJsonBytes(await boundedBody(req, 4096)) as { code?: string };
        if (!process.env.WORKSPACE_ACCESS_CODE || !await equalSecret(String(body.code ?? ''), process.env.WORKSPACE_ACCESS_CODE)) { respond({ error: '访问码不正确，请使用当前工作区的访问码。' }, 401); return; }
        res.setHeader('set-cookie', await sessionCookie(process.env.WORKSPACE_ACCESS_CODE, sessionOrigin, false)); respond({ authenticated: true }); return;
      }
      if (!authenticated) { respond({ error: '请先连接工作区。' }, 401); return; }
      if (url.pathname === '/workspace/logout' && req.method === 'POST') { res.setHeader('set-cookie', 'worknet_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); respond({ ok: true }); return; }
      if (req.method === 'GET' && ['/workspace/state', '/api/workspace/snapshot'].includes(url.pathname)) { respond(await workspace.snapshot(publicConfig)); return; }
      if (req.method === 'POST' && ['/workspace/commands', '/api/workspace/command'].includes(url.pathname)) {
        if (!req.headers['content-type']?.startsWith('application/json')) { respond({ error: '请使用 JSON 请求。' }, 415); return; }
        try { const input = parseJsonBytes(await boundedBody(req, 16384)) as { id?: string }; const result = await workspace.run(input); respond({ id: input.id, status: 'complete', result, createdAt: Date.now() }); }
        catch (error) { respond({ error: error instanceof WorkspaceError ? error.message : '操作尚未完成，请检查参数、预算与服务状态后重试。' }, 400); }
        return;
      }
      respond({ error: 'NOT_FOUND' }, 404); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') { respond({ ready: true, reviewer: state.get('runtime-health') }); return; }
    if (req.method === 'GET' && url.pathname === '/api/config') { respond(publicConfig); return; }
    if (req.method === 'GET' && url.pathname === '/api/budget') { respond(await requester.budget()); return; }
    if (req.method === 'GET' && url.pathname === '/api/tasks') { respond(await listTasks()); return; }
    const match = /^\/api\/tasks\/([1-9][0-9]*)$/.exec(url.pathname);
    if (req.method === 'GET' && match) {
      const id = BigInt(match[1]!); const task = await getCachedTask(signer.client, config, state, id);
      const events = state.db.prepare('SELECT data FROM events ORDER BY rowid').all().map(row => JSON.parse(String(row.data))).filter(event => event.args?.taskId === id.toString());
      let result: unknown; let resultError: string | undefined;
      if (task.status === 2 || task.status === 3) try { const key = `api-result:${id}:${task.attempt}:${task.resultHash}`; result = state.get(key); if (!result) { result = (await requester.submission(id)).result; state.set(key, result); } } catch { resultError = '结果当前不可读取'; }
      respond({ taskId: id, ...task, result, resultError, verification: evidenceFor(id), events }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const tick = () => res.write(`event: heartbeat\ndata: ${json({ at: Date.now(), health: state.get('runtime-health') })}\n\n`);
      tick(); const interval = setInterval(tick, 2000); req.once('close', () => clearInterval(interval)); return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const demo = url.pathname === '/api/demo' && config.mode === 'local-demo' && origin && origins.has(origin) && req.headers['x-demo-action'] === '1';
      if (!auth(req) && !demo) { respond({ error: 'UNAUTHORIZED' }, 401); return; }
      if (!req.headers['content-type']?.startsWith('application/json')) { respond({ error: 'JSON_REQUIRED' }, 415); return; }
      const body = parseJsonBytes(await boundedBody(req)) as Record<string, unknown>;
      if (url.pathname === '/api/hire') { respond(await requester.hire(validateTaskSpec(body.spec))); return; }
      if (url.pathname === '/api/demo') {
        if (config.mode !== 'local-demo') throw new Error('DEMO_REQUIRES_LOCAL_CHAIN');
        if (typeof body.runKey !== 'string' || !/^[a-zA-Z0-9/_-]{1,128}$/.test(body.runKey) || !['transfer', 'research', 'team'].includes(String(body.kind)) || !['extractive', 'llm'].includes(String(body.mode))) throw new Error('INVALID_DEMO_REQUEST');
        const kinds = body.kind === 'team' ? ['transfer', 'research'] as const : [body.kind as 'transfer' | 'research'];
        const results = []; for (const kind of kinds) results.push(await preset(kind, body.runKey, body.mode as 'extractive' | 'llm'));
        respond({ tasks: results }); return;
      }
      if (['/api/accept', '/api/reject', '/api/cancel'].includes(url.pathname)) {
        if (typeof body.taskId !== 'string' || !/^[1-9][0-9]*$/.test(body.taskId)) throw new Error('INVALID_TASK_ID');
        const id = BigInt(body.taskId);
        if (url.pathname === '/api/cancel') { respond({ transactionHash: await requester.cancel(id) }); return; }
        if (typeof body.attempt !== 'string' || !/^[1-9][0-9]*$/.test(body.attempt) || typeof body.resultHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(body.resultHash)) throw new Error('INVALID_SUBMISSION');
        const evidence = evidenceFor(id).find(e => e.attempt === body.attempt && e.resultHash === body.resultHash);
        if (url.pathname === '/api/accept') {
          if (!evidence || evidence.verdict !== 'accept') throw new Error('MATCHING_ACCEPT_EVIDENCE_REQUIRED');
          respond({ transactionHash: await requester.accept(id, BigInt(body.attempt), body.resultHash as Hex) });
        } else {
          if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000) throw new Error('REJECT_REASON_REQUIRED');
          const reason = { taskId: body.taskId, attempt: body.attempt, resultHash: body.resultHash, reason: body.reason };
          state.set(`reject-reason:${id}:${body.attempt}`, reason);
          respond({ transactionHash: await requester.reject(id, BigInt(body.attempt), body.resultHash as Hex, hashJson(reason)) });
        }
        return;
      }
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      let relative = decodeURIComponent(url.pathname); if (relative === '/') relative = '/index.html';
      const file = path.resolve(staticRoot, `.${relative}`);
      if (!file.startsWith(staticRoot + path.sep)) { respond({ error: 'NOT_FOUND' }, 404); return; }
      const bytes = await readFile(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (!bytes) { respond({ error: 'NOT_FOUND' }, 404); return; }
      res.setHeader('content-type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'application/octet-stream');
      res.end(bytes); return;
    }
    respond({ error: 'NOT_FOUND' }, 404);
  } catch (error) {
    const detail = String(error);
    log({ event: 'api-error', path: url.pathname, detail: detail.slice(0, 1000) });
    const code = ['TASK_REQUEST_EXPIRED', 'REQUEST_ID_CONFLICT', 'BUDGET_EXCEEDED', 'AUTHORIZATION_INACTIVE', 'LLM_NOT_CONFIGURED', 'MATCHING_ACCEPT_EVIDENCE_REQUIRED'].find(code => detail.includes(code));
    const messages: Record<string, string> = {
      TASK_REQUEST_EXPIRED: '这次未发布请求的 deadline 已过期。请明确开始一次新请求。', REQUEST_ID_CONFLICT: '请求 ID 已绑定其他参数，请检查原始请求。',
      BUDGET_EXCEEDED: '任务奖励超出可用预算或单笔限额。', AUTHORIZATION_INACTIVE: 'Agent 授权尚未生效或已经失效。',
      LLM_NOT_CONFIGURED: '尚未配置真实模型服务，请选择确定性摘录模式。', MATCHING_ACCEPT_EVIDENCE_REQUIRED: '没有与当前提交匹配的成功验证证据，不能付款。',
    };
    respond({ code: code ?? 'REQUEST_FAILED', error: code ? messages[code] : '操作未完成。请检查任务状态或开发日志后重试；请求 ID 保持不变。' }, 400);
  }
});
server.requestTimeout = 60000;
server.listen(port, '127.0.0.1', () => log({ event: 'daemon-ready', port, mode: config.mode }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => {
  closing = true; clearInterval(timer); server.closeAllConnections(); server.close();
  while (running) await new Promise(resolve => setTimeout(resolve, 50));
  await signer.close(); state.close();
});
