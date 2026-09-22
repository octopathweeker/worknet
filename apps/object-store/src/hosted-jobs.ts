import { reserveModelAttempt } from './model-gateway.js';
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
  return { agents: [], disabled: true };
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
  throw new Error('HOSTED_DISABLED');
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
