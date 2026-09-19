import { z } from 'zod';
import { encodeAbiParameters, keccak256, stringToHex, type Address } from 'viem';
import { hashJson } from '@agent-task/protocol/json';
import type { TaskSpec } from '@agent-task/protocol';

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(s => s.toLowerCase() as Address);
export const idSchema = z.string().uuid();
export const planSchema = z.object({
  id: idSchema, goal: z.string().trim().min(8).max(2000), kind: z.enum(['analysis', 'research']),
  reward: z.string().regex(/^[1-9][0-9]{3,5}$/).refine(s => BigInt(s) >= 10000n && BigInt(s) <= 200000n),
  sourceUrls: z.array(z.string().url().max(512)).min(1).max(3).optional(),
  fromBlock: z.string().regex(/^\d{1,16}$/).optional(), toBlock: z.string().regex(/^\d{1,16}$/).optional(),
}).strict();
export type PlanInput = z.infer<typeof planSchema>;
export type PlatformConfig = { chainId: 10143; manager: Address; factory: Address; token: Address; operator: Address; worker: Address; sponsor: Address; rpcUrl: string; storageUrl: string; deploymentBlock?: string };
export type PlatformGoal = { id: string; owner: Address; vault: Address; input: PlanInput; createdAt: string; status: 'draft' | 'queued' | 'running' | 'attention' | 'completed'; spec?: TaskSpec; taskId?: string; task?: any; result?: any; evidence?: any; verificationHistory?: any[]; audit?: { verdict: string; reason: string }; error?: string; events?: any[] };
export const serialize = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
export const capabilityHash = (name: string) => keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [name, '1.0.0']));

/** Public research is intentionally limited to established document hosts in this release. */
export function researchUrl(uri: string) {
  const u = new URL(uri);
  if (u.protocol !== 'https:' || u.hostname !== 'docs.monad.xyz' || u.username || u.password || u.port || u.search || u.hash) throw new Error('SOURCE_NOT_ALLOWED');
  return u.href;
}
export function makeTask(goal: PlatformGoal, config: PlatformConfig, now: number, head: bigint): TaskSpec {
  const research = goal.input.kind === 'research';
  const urls = goal.input.sourceUrls ?? ['https://docs.monad.xyz/developer-essentials/eip-7702.md'];
  if (research) urls.forEach(researchUrl);
  const to = BigInt(goal.input.toBlock ?? head.toString()); const from = BigInt(goal.input.fromBlock ?? (to > 99n ? to - 99n : 0n).toString());
  if (!research && (from > to || to > head || to - from > 1000n)) throw new Error('INVALID_BLOCK_RANGE');
  return {
    protocol: 'agent-task/0.1', settlementChainId: '10143', taskManager: config.manager.toLowerCase(), requester: goal.vault.toLowerCase(), clientRequestId: keccak256(stringToHex(`platform/${goal.owner}/${goal.id}`)),
    capability: research ? 'research.web' : 'analysis.token-transfers', capabilityVersion: '1.0.0', title: goal.input.goal.slice(0, 150),
    instructions: research ? `${goal.input.goal}\n仅根据指定来源回答，每项结论有精确引文，明确资料局限。` : `${goal.input.goal}\n完整复算指定区间的测试 USDC Transfer 数量与金额。`,
    input: research ? { mode: 'llm', sourceUrls: urls } : { sourceChainId: '10143', token: config.token.toLowerCase(), fromBlock: from.toString(), toBlock: to.toString() },
    outputSchema: research ? {
      type: 'object', additionalProperties: false, required: ['mode', 'summary', 'findings'], properties: { mode: { const: 'llm' }, summary: { type: 'string', minLength: 1, maxLength: 5000 }, findings: { type: 'array', minItems: urls.length, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['title', 'claim', 'sourceUri', 'quote'], properties: { title: { type: 'string', maxLength: 500 }, claim: { type: 'string', minLength: 1, maxLength: 2000 }, sourceUri: { type: 'string', maxLength: 512 }, quote: { type: 'string', minLength: 20, maxLength: 2000 } } } } },
    } : { type: 'object', additionalProperties: false, required: ['eventCount', 'totalAmountBaseUnits'], properties: { eventCount: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' }, totalAmountBaseUnits: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' } } },
    reward: { token: config.token.toLowerCase(), amountBaseUnits: goal.input.reward }, execution: { taskDeadline: now + 3600, claimLeaseSeconds: research ? 600 : 240, reviewWindowSeconds: 600 },
    verification: { profile: research ? 'research-sources-and-judge' : 'rpc-transfer-aggregate', profileVersion: '1.0.0', criteria: research ? ['回答承诺的目标；每项结论由指定资料中的精确引文支持'] : ['事件数和金额经独立完整复算一致'], unverifiableAction: 'reject' },
  };
}
export function taskParams(spec: TaskSpec, storageUrl: string) {
  const hash = hashJson(spec);
  return { capabilityId: capabilityHash(spec.capability), specHash: hash, specURI: `${storageUrl}/objects/${hash}`, rewardAmount: BigInt(spec.reward.amountBaseUnits), taskDeadline: BigInt(spec.execution.taskDeadline), claimLeaseSeconds: spec.execution.claimLeaseSeconds, reviewWindowSeconds: spec.execution.reviewWindowSeconds };
}
export const researchOutput = z.object({ mode: z.literal('llm'), summary: z.string().min(1).max(5000), findings: z.array(z.object({ title: z.string().max(500), claim: z.string().min(1).max(2000), sourceUri: z.string().max(512), quote: z.string().min(20).max(2000) }).strict()).min(1).max(8) }).strict();
export const transferOutput = z.object({ eventCount: z.string().regex(/^(0|[1-9][0-9]*)$/), totalAmountBaseUnits: z.string().regex(/^(0|[1-9][0-9]*)$/) }).strict();
export function publicPlatformError(error: unknown): string {
  const message = String(error);
  const messages: Record<string, string> = { BUDGET_AMOUNT_INVALID: '充值及累计授权额度为 0.01–5 test USDC，最多 6 位小数。', SOURCE_NOT_ALLOWED: '目前支持 docs.monad.xyz 的公开资料，请调整来源。', INVALID_BLOCK_RANGE: '请选择不超过 1,001 个已确认区块的范围。', BUDGET_UNAVAILABLE: '预算不足或授权已到期，请先检查预算设置。', SIGNATURE_INVALID: '钱包签名不匹配或已失效，请重新登录。', REQUEST_CONFLICT: '该操作编号已绑定其他内容，请恢复原操作。', RATE_LIMIT: '操作较频繁，请稍后重试。', SPONSOR_LIMIT: '当前 gas 赞助额度已用完，请稍后再试或使用钱包直接操作。', WRONG_DELEGATION: '此账户尚未启用受支持的智能账户，请使用钱包操作。', INTENT_EXPIRED: '该授权计划已过期，请重新准备。', USER_ACTION_REQUIRED: '需要 Owner 钱包处理当前任务，请查看任务详情。' };
  return Object.entries(messages).find(([code]) => message.includes(code))?.[1] ?? '操作尚未完成。请稍后重试原操作；如仍失败，请查看执行记录。';
}
