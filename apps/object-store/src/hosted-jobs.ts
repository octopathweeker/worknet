import { generationAvailable, freeModels, reserveModelAttempt } from './model-gateway.js';
import { z } from 'zod';
import type { Env } from './index.js';
import type { RunRow } from './taker-api.js';
import { serialize } from './platform-domain.js';

export const hostedAgentSchema = z.enum(['research-v1', 'transfers-v1']);
export const hostedAgents = [
  { id: 'research-v1', name: '资料研究 Agent', capability: 'research.web', description: '阅读任务指定的 Monad 官方资料，生成带原文引用的交付。' },
  { id: 'transfers-v1', name: '链上分析 Agent', capability: 'analysis.token-transfers', description: '查询任务约定区间的测试 USDC 转账，汇总次数与金额。' },
] as const;
export const hostedLimits = { activePerUser: 2, dailyPerUser: 5, activeGlobal: 20, modelRequestsPerDay: 40, executionTries: 2, executionTimeoutSeconds: 150 } as const;
export type HostedBody = {
  id: string; owner: string; agent: string; agentName: string; taskId: string; attempt: string;
  status: 'waiting_authorization' | 'waiting_claim' | 'running' | 'ready' | 'submitting' | 'reviewing' | 'completed' | 'settled_unverified' | 'settled_scored' | 'stopped' | 'failed' | 'expired' | 'rejected';
  message: string; resultHash?: string; metrics: { modelRequests: number; toolQueries: number; executionTries: number };
  costs: { serviceFeeBaseUnits: '0'; computePayer: 'platform'; gasPayer: string; confirmedGasWei: string | null; gasTransactions: Array<{ hash: string; paidWei: string; payer: string }> };
  logs: Array<{ at: string; stage: string; message: string }>; createdAt: string; updatedAt: string;
};
export type HostedRow = { id: string; owner: string; agent: string; body: string; active: number; cancelled: number; created_at: number; updated_at: number };
export function hostedCatalog(env: Env) {
  return { agents: hostedAgents.map(agent => ({ ...agent, available: Boolean(env.HOSTED && env.DB && (agent.capability !== 'research.web' || generationAvailable(env))), model: agent.capability === 'research.web' ? env.PLATFORM_GENERATION_PROVIDER === 'openrouter' ? freeModels(env).join(', ') : env.PLATFORM_AI_MODEL ?? null : null })), limits: hostedLimits, fees: { serviceFeeBaseUnits: '0', token: 'test USDC', computePayer: 'platform', description: '测试期间不收取执行服务费；模型与工具资源由平台承担，交易 gas 按钱包确认方式支付。' } };
}
export async function getHostedJob(env: Env, id: string, owner: string) {
  const row = await env.DB!.prepare('SELECT * FROM platform_hosted_jobs WHERE id=? AND owner=?').bind(id, owner).first<HostedRow>();
  return row ? { ...row, data: JSON.parse(row.body) as HostedBody } : null;
}
export async function wakeHostedJob(env: Env, row: RunRow, operation = 'wake') {
  if (!env.HOSTED) throw new Error('HOSTED_UNAVAILABLE');
  const response = await env.HOSTED.get(env.HOSTED.idFromName(row.id)).fetch(`https://internal/${operation}`, { method: 'POST', body: JSON.stringify({ id: row.id, owner: row.owner }) });
  if (!response.ok) throw new Error('HOSTED_UNAVAILABLE');
}
export async function ensureHostedJob(env: Env, row: RunRow) {
  const body = JSON.parse(row.body);
  if (!body.hostedAgent) return null;
  if (!env.HOSTED) throw new Error('HOSTED_UNAVAILABLE');
  const agent = hostedAgents.find(a => a.id === body.hostedAgent);
  if (!agent || body.spec?.capability !== agent.capability || row.executor_id) throw new Error('HOSTED_AGENT_MISMATCH');
  const previous = await getHostedJob(env, row.id, row.owner);
  if (previous) { if (previous.active) await wakeHostedJob(env, row); return previous.data; }
  if (row.revoked || body.validUntil * 1000 <= Date.now()) throw new Error('GRANT_EXPIRED');
  if (agent.capability === 'research.web' && (!env.AI || !env.PLATFORM_AI_MODEL)) throw new Error('HOSTED_MODEL_UNAVAILABLE');
  const at = new Date().toISOString();
  const data: HostedBody = { id: row.id, owner: row.owner, agent: agent.id, agentName: agent.name, taskId: row.task_id, attempt: row.attempt, status: body.authorized ? 'waiting_claim' : 'waiting_authorization', message: body.authorized ? '等待钱包确认领取；确认后开始云端执行。' : '等待本轮钱包授权。', metrics: { modelRequests: 0, toolQueries: 0, executionTries: 0 }, costs: { serviceFeeBaseUnits: '0', computePayer: 'platform', gasPayer: body.mode === 'sponsored' ? 'platform' : row.owner, confirmedGasWei: null, gasTransactions: [] }, logs: [{ at, stage: 'prepared', message: '已准备托管执行；尚未运行模型或领取任务。' }], createdAt: at, updatedAt: at };
  const dayStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  await env.DB!.prepare(`INSERT OR IGNORE INTO platform_hosted_jobs(id,owner,agent,body,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM platform_hosted_jobs WHERE owner=? AND active=1)<? AND (SELECT count(*) FROM platform_hosted_jobs WHERE owner=? AND created_at>=?)<? AND (SELECT count(*) FROM platform_hosted_jobs WHERE active=1)<?`).bind(row.id,row.owner,agent.id,serialize(data),Date.now(),Date.now(),row.owner,hostedLimits.activePerUser,row.owner,dayStart,hostedLimits.dailyPerUser,hostedLimits.activeGlobal).run();
  const saved = await getHostedJob(env, row.id, row.owner);
  if (!saved) {
    const counts = await env.DB!.prepare('SELECT (SELECT count(*) FROM platform_hosted_jobs WHERE owner=? AND active=1) running, (SELECT count(*) FROM platform_hosted_jobs WHERE owner=? AND created_at>=?) daily').bind(row.owner,row.owner,dayStart).first<{running:number;daily:number}>();
    throw new Error(counts && counts.daily>=hostedLimits.dailyPerUser ? 'HOSTED_QUOTA_DAILY' : counts && counts.running>=hostedLimits.activePerUser ? 'HOSTED_QUOTA_ACTIVE' : 'HOSTED_QUOTA_GLOBAL');
  }
  await wakeHostedJob(env, row); return saved.data;
}
export async function stopHostedJob(env: Env, row: RunRow, message: string) {
  if (!JSON.parse(row.body).hostedAgent) return;
  const at = new Date().toISOString();
  await env.DB!.prepare("UPDATE platform_hosted_jobs SET cancelled=1,active=0,updated_at=?,body=json_set(body,'$.status','stopped','$.message',?,'$.updatedAt',?,'$.logs[#]',json(?)) WHERE id=? AND owner=? AND active=1").bind(Date.now(),message,at,serialize({at,stage:'stopped',message}),row.id,row.owner).run();
  // The durable flag is authoritative even if waking the in-flight computation fails.
  await wakeHostedJob(env,row,'cancel').catch(() => undefined);
}
export async function reserveHostedModelRequest(env: Env) {
  await reserveModelAttempt(env,env.PLATFORM_GENERATION_PROVIDER ?? 'cloudflare','generation');
}
