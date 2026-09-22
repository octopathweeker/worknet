import { attachGoalProgress } from './task-progress.js';
import { taskToolPayments } from './tool-payments.js';
import { reviewPublicKey } from './private-deliveries.js';
import { deliverySalt } from '@agent-task/privacy';
import { quorumAvailable } from './platform-quorum.js';
import {platformActivity,markActivityRead} from './platform-activity.js';
import { generationAvailable, freeModels } from './model-gateway.js';
import { briefInputSchema, prepareBrief } from './platform-brief.js';
import { createPublicClient, http, encodeFunctionData, erc20Abi, keccak256, stringToHex, recoverMessageAddress, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { monadTestnet } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';
import { requesterVaultAbi } from '@agent-task/contracts';
import { exactPermission, permissionTypedData, factoryAbi, isSupportedDelegation, delegatedImplementation, type AccountCall } from '@agent-task/accounts';
import { hashJson, parseJsonStrict } from '@agent-task/protocol/json';
import { z } from 'zod';
import { addressSchema, idSchema, planSchema, researchUrl, publicPlatformError, serialize, type PlatformConfig, type PlatformGoal } from './platform-domain.js';
import type { Env } from './index.js';

export function platformConfig(env: Env): PlatformConfig {
  const config = JSON.parse(env.PLATFORM_CONFIG ?? '{}') as PlatformConfig;
  if (env.QUICKNODE_RPC_URL) {
    let url: URL; try { url = new URL(env.QUICKNODE_RPC_URL); } catch { throw new Error('QUICKNODE_CONFIG_INVALID'); }
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.quiknode.pro') || url.username || url.password || url.port) throw new Error('QUICKNODE_CONFIG_INVALID');
    config.rpcUrl = url.href;
  }
  if (config.chainId !== 10143 || !config.manager || !config.factory || !config.operator || !config.sponsor || !config.worker || new URL(config.rpcUrl).protocol !== 'https:') throw new Error('PLATFORM_NOT_CONFIGURED');
  return config;
}
export function platformClient(config: PlatformConfig) { return createPublicClient({ chain: monadTestnet, transport: http(config.rpcUrl, { timeout: 15000, retryCount: 1 }), cacheTime: 0 }); }
export async function platformBody(request: Request, max = 20000): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('JSON_REQUIRED');
  if (!request.body) throw new Error('BODY_REQUIRED');
  const reader = request.body.getReader(); let bytes = 0; const decoder = new TextDecoder('utf-8', { fatal: true }); let value = '';
  try { while (true) { const { done, value: chunk } = await reader.read(); if (done) break; bytes += chunk.length; if (bytes > max) { await reader.cancel(); throw new Error('BODY_LIMIT'); } value += decoder.decode(chunk, { stream: true }); } value += decoder.decode(); }
  finally { reader.releaseLock(); }
  return parseJsonStrict(value);
}
const cookieName = 'worknet_user';
export async function platformSession(request: Request, env: Env) {
  const token = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return env.DB!.prepare('SELECT address,hash FROM platform_sessions WHERE hash=? AND expires_at>?').bind(keccak256(stringToHex(token)), Date.now()).first<{ address: Address; hash: Hex }>();
}
export async function platformRate(env: Env, key: string, limit: number, window = 60000) {
  const expires = Math.floor(Date.now() / window) * window + window;
  const row = await env.DB!.prepare('INSERT INTO platform_rate(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END, expires_at=excluded.expires_at RETURNING count').bind(key, expires, Date.now()).first<{ count: number }>();
  if (!row || row.count > limit) throw new Error('RATE_LIMIT');
}
export async function enqueue(env: Env, owner: Address, id: string, type: string, payload: unknown) {
  const fingerprint = hashJson({ owner, type, payload });
  await env.DB!.prepare("INSERT OR IGNORE INTO platform_commands(id,owner,type,fingerprint,payload,status,created_at) VALUES (?,?,?,?,?,'queued',?)").bind(id, owner, type, fingerprint, serialize(payload), Date.now()).run();
  const row = await env.DB!.prepare('SELECT owner,fingerprint,status,result FROM platform_commands WHERE id=?').bind(id).first<{ owner: string; fingerprint: string; status: string; result: string | null }>();
  if (!row || row.owner !== owner || row.fingerprint !== fingerprint) throw new Error('REQUEST_CONFLICT');
  const wake = await env.PLATFORM!.get(env.PLATFORM!.idFromName('coordinator-v1')).fetch('https://internal/wake', { method: 'POST' });
  if (!wake.ok) throw new Error('COORDINATOR_UNAVAILABLE');
  return { id, status: row.status, result: row.result ? JSON.parse(row.result) : null };
}
export async function platformApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  const reply = (data: unknown, status = 200) => new Response(serialize(data), { status, headers });
  if (!env.DB || !env.PLATFORM || !env.PLATFORM_CONFIG) return reply({ error: '独立账户服务尚未配置。' }, 503);
  try {
    if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) return reply({ error: '请求来源不匹配，请在平台页面操作。' }, 403);
    const config = platformConfig(env); const client = platformClient(config);
    if (url.pathname === '/platform/config' && request.method === 'GET') {
      const { rpcUrl: _rpc, ...publicConfig } = config;
      Object.assign(publicConfig, { environment: env.WORKNET_ENVIRONMENT ?? 'development', publicOrigin: env.WORKNET_PUBLIC_ORIGIN ?? url.origin });
      const health = await env.DB.prepare("SELECT body,updated_at FROM platform_health WHERE id='current'").first<{ body: string; updated_at: number }>();
      return reply({ ...publicConfig, privacy: { rpId: url.hostname, reviewPublicKey: reviewPublicKey(env) ?? null }, rpcWalletUrl: 'https://testnet-rpc.monad.xyz', delegatedImplementation, modelAvailable: Boolean(generationAvailable(env) && (config.quorum ? quorumAvailable(env, config) : env.AI && env.PLATFORM_JUDGE_MODEL)), model: env.PLATFORM_GENERATION_PROVIDER === 'openrouter' ? freeModels(env).join(', ') : env.PLATFORM_AI_MODEL, generationProvider: env.PLATFORM_GENERATION_PROVIDER ?? 'cloudflare', rpcProvider: env.QUICKNODE_RPC_URL ? 'quicknode' : 'configured', judgeProvider: config.quorum ? 'openrouter' : 'cloudflare', judgeModel: config.quorum ? 'typesafe/jev-1.13' : env.PLATFORM_JUDGE_MODEL, health: health ? { ...JSON.parse(health.body), updatedAt: health.updated_at } : null });
    }
    if (url.pathname === '/platform/auth/challenge' && request.method === 'POST') {
      const { address } = z.object({ address: addressSchema }).strict().parse(await platformBody(request));
      await platformRate(env, `challenge-ip:${request.headers.get('cf-connecting-ip') ?? 'local'}`, 20); await platformRate(env, `challenge:${address}`, 5);
      const id = crypto.randomUUID(); const nonce = crypto.randomUUID().replaceAll('-', ''); const issuedAt = new Date(); const expirationTime = new Date(issuedAt.getTime() + 300000);
      const message = createSiweMessage({ domain: url.host, address, statement: '登录 Worknet。此签名不授权转账或发布任务。', uri: url.origin, version: '1', chainId: 10143, nonce, issuedAt, expirationTime });
      await env.DB.prepare('INSERT INTO platform_challenges(id,address,message,expires_at) VALUES (?,?,?,?)').bind(id, address, message, expirationTime.getTime()).run();
      return reply({ id, message });
    }
    if (url.pathname === '/platform/auth/verify' && request.method === 'POST') {
      const { id, signature } = z.object({ id: idSchema, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict().parse(await platformBody(request));
      const challenge = await env.DB.prepare('SELECT address,message FROM platform_challenges WHERE id=? AND consumed=0 AND expires_at>?').bind(id, Date.now()).first<{ address: Address; message: string }>();
      if (!challenge || (await recoverMessageAddress({ message: challenge.message, signature: signature as Hex })).toLowerCase() !== challenge.address) throw new Error('SIGNATURE_INVALID');
      // One atomic claim prevents concurrent reuse of the login signature.
      const consumed = await env.DB.prepare('UPDATE platform_challenges SET consumed=1 WHERE id=? AND consumed=0 AND expires_at>? RETURNING id').bind(id, Date.now()).first();
      if (!consumed) throw new Error('SIGNATURE_INVALID');
      const vault = await client.readContract({ address: config.factory, abi: factoryAbi, functionName: 'predictVault', args: [challenge.address] });
      await env.DB.prepare('INSERT OR IGNORE INTO platform_users(address,vault,created_at) VALUES (?,?,?)').bind(challenge.address, vault.toLowerCase(), Date.now()).run();
      const bytes = crypto.getRandomValues(new Uint8Array(32)); const token = [...bytes].map(v => v.toString(16).padStart(2, '0')).join('');
      await env.DB.prepare('INSERT INTO platform_sessions(hash,address,expires_at) VALUES (?,?,?)').bind(keccak256(stringToHex(token)), challenge.address, Date.now() + 8 * 3600000).run();
      headers.set('set-cookie', `${cookieName}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/platform; Max-Age=28800`);
      return reply({ authenticated: true, address: challenge.address });
    }
    const login = await platformSession(request, env);
    if (url.pathname === '/platform/session' && request.method === 'GET') return reply({ authenticated: Boolean(login), address: login?.address });
    if (!login) return reply({ error: '请先用自己的钱包登录。' }, 401);
    const owner = login.address;
    if (request.method !== 'GET') await platformRate(env, `write:${owner}`, 30);
    if (url.pathname === '/platform/activity' && request.method === 'GET') { await platformRate(env,`activity:${owner}`,30); return reply({items:await platformActivity(env,owner),limitPerRole:60}); }
    if (url.pathname === '/platform/activity/read' && request.method === 'POST') { const {ids}=z.object({ids:z.array(z.string().regex(/^0x[0-9a-f]{64}$/)).max(120)}).strict().parse(await platformBody(request)); await markActivityRead(env,owner,ids); return reply({ok:true}); }
    if (url.pathname === '/platform/model-usage' && request.method === 'GET') {
      const row = await env.DB.prepare("SELECT json_group_array(json(item)) items FROM (SELECT json_object('provider',provider,'stage',stage,'model',model,'requests',count(*),'succeeded',sum(status='succeeded'),'inputTokens',sum(input_tokens),'outputTokens',sum(output_tokens),'unknownUsage',sum(input_tokens IS NULL OR output_tokens IS NULL)) item FROM platform_model_calls WHERE owner=? AND created_at>=? GROUP BY provider,stage,model)").bind(owner,Date.parse(new Date().toISOString().slice(0,10))).first<{items:string}>();
      return reply({day:new Date().toISOString().slice(0,10),usage:JSON.parse(row?.items??'[]'),note:'仅本账户今日生成与审核记录；token 未返回时不按零计。'});
    }
    if (url.pathname === '/platform/logout' && request.method === 'POST') {
      await env.DB.prepare('DELETE FROM platform_sessions WHERE hash=?').bind(login.hash).run(); headers.set('set-cookie', `${cookieName}=; HttpOnly; Secure; SameSite=Strict; Path=/platform; Max-Age=0`); return reply({ ok: true });
    }
    const user = await env.DB.prepare('SELECT vault FROM platform_users WHERE address=?').bind(owner).first<{ vault: Address }>(); if (!user) throw new Error('UNKNOWN_USER');
    if (url.pathname === '/platform/account' && request.method === 'GET') {
      const [code, deployed, walletBalance, monBalance, block] = await Promise.all([client.getCode({ address: owner }), client.getCode({ address: user.vault }), client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }), client.getBalance({ address: owner }), client.getBlock()]);
      let budget: unknown = null;
      if (deployed && deployed !== '0x') {
        const [auth, balance, paused] = await Promise.all([client.readContract({ address: user.vault, abi: requesterVaultAbi, functionName: 'getAuthorization', args: [config.operator], blockNumber: block.number }), client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [user.vault], blockNumber: block.number }), client.readContract({ address: user.vault, abi: requesterVaultAbi, functionName: 'paused', blockNumber: block.number })]);
        const active = auth.active && !paused && auth.validAfter <= block.timestamp && auth.validUntil > block.timestamp;
        const remaining = auth.maxTotalCommitment - auth.committed;
        budget = { ...auth, vaultBalance: balance, paused, effectiveActive: active, newCommitmentCapacity: active ? balance < remaining ? balance : remaining : 0n };
      }
      return reply({ address: owner, vault: user.vault, chainTimestamp: block.timestamp, deployed: Boolean(deployed && deployed !== '0x'), accountMode: isSupportedDelegation(code) ? 'metamask-7702' : code && code !== '0x' ? 'other-smart-account' : 'eoa', walletBalance, monBalance, budget });
    }
    if (url.pathname === '/platform/setup' && request.method === 'POST') {
      const { id, amount, mode } = z.object({ id: idSchema, amount: z.string(), mode: z.enum(['recharge', 'authorize']).default('recharge') }).strict().parse(await platformBody(request));
      if (!/^[1-9][0-9]{3,6}$/.test(amount) || BigInt(amount) < 10000n || BigInt(amount) > 5000000n) throw new Error('BUDGET_AMOUNT_INVALID');
      const previous = await env.DB.prepare('SELECT owner,body FROM platform_intents WHERE id=?').bind(id).first<{ owner: string; body: string }>();
      if (previous) { const body = JSON.parse(previous.body); if (previous.owner !== owner || body.amount !== amount || (body.mode ?? 'recharge') !== mode) throw new Error('REQUEST_CONFLICT'); return reply(body); }
      if (mode === 'authorize') {
        const [code, balance] = await Promise.all([client.getCode({ address: user.vault }), client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [user.vault] })]);
        if (!code || code === '0x' || balance < BigInt(amount)) throw new Error('BUDGET_UNAVAILABLE');
      }
      const now = Number((await client.getBlock()).timestamp); const validUntil = now + 600;
      const calls: AccountCall[] = [
        { target: config.factory, value: 0n, callData: encodeFunctionData({ abi: factoryAbi, functionName: 'createVault', args: [owner] }) },
        { target: config.token, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [user.vault, BigInt(amount)] }) },
        { target: user.vault, value: 0n, callData: encodeFunctionData({ abi: requesterVaultAbi, functionName: 'deposit', args: [BigInt(amount)] }) },
        { target: user.vault, value: 0n, callData: encodeFunctionData({ abi: requesterVaultAbi, functionName: 'authorizeAgent', args: [config.operator, { validAfter: 0n, validUntil: BigInt(now + 86400), maxPerTask: BigInt(amount) < 200000n ? BigInt(amount) : 200000n, maxTotalCommitment: BigInt(amount) }] }) },
      ];
      // Renew only the payment authorization: never approve or transfer more tokens.
      const setupCalls = mode === 'authorize' ? calls.slice(-1) : calls;
      const delegation = exactPermission(owner, config.sponsor, setupCalls, id, validUntil);
      const body = { id, owner, amount, mode, vault: user.vault, validUntil, authorizationUntil: now + 86400, calls: setupCalls, delegation, typedData: permissionTypedData(delegation) };
      await env.DB.prepare('INSERT INTO platform_intents(id,owner,body,expires_at) VALUES (?,?,?,?)').bind(id, owner, serialize(body), validUntil * 1000).run(); return reply(body);
    }
    if (url.pathname === '/platform/setup/sponsor' && request.method === 'POST') {
      const payload = z.object({ id: idSchema, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict().parse(await platformBody(request));
      const row = await env.DB.prepare('SELECT body,expires_at FROM platform_intents WHERE id=? AND owner=?').bind(payload.id, owner).first<{ body: string; expires_at: number }>();
      if (!row) return reply({ error: '找不到该授权计划。' }, 404);
      const prior = await env.DB.prepare('SELECT id FROM platform_commands WHERE id=? AND owner=?').bind(payload.id, owner).first();
      if (!prior && row.expires_at <= Date.now()) throw new Error('INTENT_EXPIRED');
      const body = JSON.parse(row.body);
      const recovered = await recoverTypedDataAddress({ ...permissionTypedData(body.delegation), signature: payload.signature as Hex });
      if (recovered.toLowerCase() !== owner) throw new Error('SIGNATURE_INVALID');
      if (!isSupportedDelegation(await client.getCode({ address: owner }))) throw new Error('WRONG_DELEGATION');
      return reply(await enqueue(env, owner, payload.id, 'setup', payload), 202);
    }
    if (url.pathname === '/platform/goals' && request.method === 'GET') {
      const row = await env.DB.prepare("SELECT json_group_array(json(body)) AS items FROM (SELECT json_set(g.body,'$.publication',json((SELECT json_object('id',c.id,'status',c.status,'error',json_extract(c.result,'$.error')) FROM platform_commands c WHERE c.owner=g.owner AND c.type='launch' AND json_extract(c.payload,'$.goalId')=g.id ORDER BY c.created_at DESC,c.rowid DESC LIMIT 1))) AS body FROM platform_goals g WHERE g.owner=? ORDER BY g.updated_at DESC LIMIT 60)").bind(owner).first<{ items: string }>(); const goals = JSON.parse(row?.items ?? '[]');
      if(env.MPP_TOOL_CONFIG) await Promise.all(goals.filter((g: any)=>g.taskId&&g.task?.attempt).map(async(g: any)=>{g.toolPayments=await taskToolPayments(env,g.taskId,String(g.task.attempt));}));
      await attachGoalProgress(env, owner, goals);
      return reply({ goals });
    }
    if (url.pathname === '/platform/brief' && request.method === 'POST') {
      const input = briefInputSchema.parse(await platformBody(request, 64000));
      await platformRate(env, `brief:${owner}`, 20, 86400000);
      return reply(await prepareBrief(input, env, owner));
    }
    if (url.pathname === '/platform/plans' && request.method === 'POST') {
      const input = planSchema.parse(await platformBody(request, 64000));
      if (input.execution === 'platform') return reply({ error: '平台执行器已停用，请将任务改为开放接单。' }, 400);
      input.execution = 'market';
      if (input.kind === 'general' && (!quorumAvailable(env, config) || config.quorum!.threshold < 2)) throw new Error('JUDGE_QUORUM_UNAVAILABLE');
      if (input.delivery && (input.delivery.rpId !== url.hostname || input.delivery.salt !== deliverySalt(url.hostname,owner,input.id) || input.delivery.reviewPublicKey !== reviewPublicKey(env))) throw new Error('PRIVATE_DELIVERY_CONFIG_INVALID');
      if (input.kind === 'research') { if (!generationAvailable(env) || (config.quorum ? !quorumAvailable(env, config) : !env.AI || !env.PLATFORM_JUDGE_MODEL)) throw new Error('MODEL_UNAVAILABLE'); (input.sourceUrls ?? []).forEach(researchUrl); }
      if (input.fromBlock && input.toBlock && (BigInt(input.fromBlock) > BigInt(input.toBlock) || BigInt(input.toBlock) - BigInt(input.fromBlock) > 1000n)) throw new Error('INVALID_BLOCK_RANGE');
      const previous = await env.DB.prepare('SELECT owner,body FROM platform_goals WHERE id=?').bind(input.id).first<{ owner: string; body: string }>();
      if (previous) { const goal = JSON.parse(previous.body); if (previous.owner !== owner || hashJson(goal.input) !== hashJson(input)) throw new Error('REQUEST_CONFLICT'); return reply(goal); }
      await platformRate(env, `plans:${owner}`, 50, 86400000);
      // The user is confirming an existing agreement. Validate its schema above and
      // persist it verbatim; generating it again makes saving depend on model output
      // and can silently contradict the terms the user just reviewed. Jev evaluates
      // the delivered work against this committed agreement after submission.
      const goal: PlatformGoal = { id: input.id, owner, vault: user.vault, input, createdAt: new Date().toISOString(), status: 'draft' };
      await env.DB.prepare('INSERT INTO platform_goals(id,owner,body,updated_at) VALUES (?,?,?,?)').bind(input.id, owner, serialize(goal), Date.now()).run(); return reply(goal);
    }
    if (url.pathname === '/platform/launch' && request.method === 'POST') {
      const payload = z.object({ id: idSchema, goalId: idSchema }).strict().parse(await platformBody(request));
      if (!await env.DB.prepare('SELECT id FROM platform_goals WHERE id=? AND owner=?').bind(payload.goalId, owner).first()) return reply({ error: '找不到该计划。' }, 404);
      return reply(await enqueue(env, owner, payload.id, 'launch', payload), 202);
    }
    const match = /^\/platform\/commands\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (match && request.method === 'GET') { const row = await env.DB.prepare('SELECT id,status,result FROM platform_commands WHERE id=? AND owner=?').bind(match[1], owner).first<{ id: string; status: string; result: string | null }>(); return row ? reply({ ...row, result: row.result ? JSON.parse(row.result) : null }) : reply({ error: '找不到该操作。' }, 404); }
    return reply({ error: 'NOT_FOUND' }, 404);
  } catch (error) {
    const text = String(error); const status = text.includes('RATE_LIMIT') ? 429 : text.includes('REQUEST_CONFLICT') ? 409 : text.includes('SIGNATURE_INVALID') ? 401 : 400;
    return reply({ error: publicPlatformError(error), code: error instanceof z.ZodError ? 'INVALID_INPUT' : text.includes('SIGNATURE_INVALID') ? 'SIGNATURE_INVALID' : 'REQUEST_FAILED' }, status);
  }
}
