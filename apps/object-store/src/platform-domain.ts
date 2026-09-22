import { generalOutputSchema, publicReference, intentSchema, validQuorum } from '@agent-task/judging';
import type { QuorumConfig } from '@agent-task/judging';
import { z } from 'zod';
import { encodeAbiParameters, keccak256, stringToHex, type Address } from 'viem';
import { hashJson } from '@agent-task/protocol/json';
import type { TaskSpec } from '@agent-task/protocol';
import { deliveryConfigSchema } from '@agent-task/privacy';

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(s => s.toLowerCase() as Address);
export const idSchema = z.string().uuid();
export const agreementSchema = z.object({
  intent: intentSchema.optional(),
  deliverable: z.string().trim().min(1).max(1000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
}).strict();
export const transferAgreement = {
  deliverable: '指定区块范围内测试 USDC 的转账次数与总金额。',
  acceptanceCriteria: ['完整查询约定区块范围的测试 USDC Transfer 事件。', '转账次数与原始单位总金额经独立复算一致。'],
};
export const planSchema = z.object({
  execution: z.enum(['platform', 'market']).optional(),
  delivery: deliveryConfigSchema.optional(),
  id: idSchema, goal: z.string().trim().min(8).max(2000), kind: z.enum(['analysis', 'research', 'general']),
  reward: z.string().regex(/^[1-9][0-9]{3,5}$/).refine(s => BigInt(s) >= 10000n && BigInt(s) <= 200000n),
  sourceUrls: z.array(publicReference).min(1).max(16).optional(),
  fromBlock: z.string().regex(/^\d{1,16}$/).optional(), toBlock: z.string().regex(/^\d{1,16}$/).optional(),
  agreement: agreementSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.kind === 'general' && !input.agreement?.intent) ctx.addIssue({ code: 'custom', message: '通用任务需要交付物与验收标准。', path: ['agreement'] });
  if (input.kind === 'research' && (input.sourceUrls?.length ?? 0) > 3) ctx.addIssue({ code: 'custom', message: '文档研究最多 3 个来源。', path: ['sourceUrls'] });
  if (input.kind === 'analysis' && input.agreement && JSON.stringify(input.agreement) !== JSON.stringify(transferAgreement)) ctx.addIssue({ code: 'custom', message: '转账统计仅支持独立复算验收。', path: ['agreement'] });
});
export type PlanInput = z.infer<typeof planSchema>;
export type PlatformConfig = { release?: string; legacyUrl?: string; quorum?: QuorumConfig; chainId: 10143; manager: Address; factory: Address; token: Address; operator: Address; worker: Address; sponsor: Address; rpcUrl: string; storageUrl: string; deploymentBlock?: string };
export type PlatformGoal = { id: string; owner: Address; vault: Address; input: PlanInput; createdAt: string; status: 'draft' | 'queued' | 'running' | 'attention' | 'completed' | 'settled'; spec?: TaskSpec; taskId?: string; task?: any; result?: any; evidence?: any; verificationHistory?: any[]; settlement?: { completionBps: number; workerAmount: string; refundAmount: string; transactionHash: string }; audit?: { verdict: string; reason: string }; error?: string; events?: any[] };
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
  const general = goal.input.kind === 'general';
  if (general && !goal.input.agreement?.intent) throw new Error('AGREEMENT_REQUIRED');
  if (general && (!validQuorum(config.quorum) || config.quorum.threshold < 2)) throw new Error('JUDGE_QUORUM_UNAVAILABLE');
  const urls = goal.input.sourceUrls ?? ['https://docs.monad.xyz/developer-essentials/eip-7702.md'];
  if (research) urls.forEach(researchUrl);
  const to = BigInt(goal.input.toBlock ?? head.toString()); const from = BigInt(goal.input.fromBlock ?? (to > 99n ? to - 99n : 0n).toString());
  if (goal.input.kind === 'analysis' && (from > to || to > head || to - from > 1000n)) throw new Error('INVALID_BLOCK_RANGE');
  return {
    protocol: 'agent-task/0.1', settlementChainId: '10143', taskManager: config.manager.toLowerCase(), requester: goal.vault.toLowerCase(), clientRequestId: keccak256(stringToHex(`platform/${goal.owner}/${goal.id}`)),
    capability: general ? 'task.general' : research ? 'research.web' : 'analysis.token-transfers', capabilityVersion: '1.0.0', title: goal.input.goal.slice(0, 150),
    ...(goal.input.delivery ? { delivery: goal.input.delivery } : {}),
    instructions: (general ? `${goal.input.goal}\n由外部 Agent 完成约定工作，以 Markdown 正文交付，附实际使用的来源。区分事实、估算与假设，不伪造查询、预订或其他外部操作。` : research ? `${goal.input.goal}\n仅根据指定来源回答，每项结论有精确引文，明确资料局限。` : `${goal.input.goal}\n完整复算指定区间的测试 USDC Transfer 数量与金额。`) + (goal.input.agreement ? `\n约定交付物：${goal.input.agreement.deliverable}` : ''),
    input: general ? { referenceUrls: goal.input.sourceUrls ?? [], intent: { ...goal.input.agreement!.intent!, deliverable: goal.input.agreement!.deliverable, acceptanceCriteria: goal.input.agreement!.acceptanceCriteria } } : research ? { mode: 'llm', sourceUrls: urls } : { sourceChainId: '10143', token: config.token.toLowerCase(), fromBlock: from.toString(), toBlock: to.toString() },
    outputSchema: general ? generalOutputSchema : research ? {
      type: 'object', additionalProperties: false, required: ['mode', 'summary', 'findings'], properties: { mode: { const: 'llm' }, summary: { type: 'string', minLength: 1, maxLength: 5000 }, findings: { type: 'array', minItems: urls.length, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['title', 'claim', 'sourceUri', 'quote'], properties: { title: { type: 'string', maxLength: 500 }, claim: { type: 'string', minLength: 1, maxLength: 2000 }, sourceUri: { type: 'string', maxLength: 512 }, quote: { type: 'string', minLength: 20, maxLength: 2000 } } } } },
    } : { type: 'object', additionalProperties: false, required: ['eventCount', 'totalAmountBaseUnits'], properties: { eventCount: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' }, totalAmountBaseUnits: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' } } },
    reward: { token: config.token.toLowerCase(), amountBaseUnits: goal.input.reward }, execution: { taskDeadline: now + 3600, claimLeaseSeconds: general ? 1800 : research ? 600 : 240, reviewWindowSeconds: 600 },
    verification: { profile: general ? 'jev.quorum' : research ? (config.quorum ? 'jev.quorum' : 'research-sources-and-judge') : 'rpc-transfer-aggregate', profileVersion: '1.0.0', criteria: [...(general ? ['交付覆盖约定目标，明确假设和估算；来源与执行证据真实，不把未核实的信息或未执行的外部操作声称为已验证完成。'] : research ? ['回答承诺的目标；每项结论由指定资料中的精确引文支持'] : ['事件数和金额经独立完整复算一致']), ...(goal.input.agreement?.acceptanceCriteria ?? []), ...(general ? [...goal.input.agreement!.intent!.constraints.map(c => `约束：${c}`), ...goal.input.agreement!.intent!.evidenceRequirements.map(c => `证据要求：${c}`)] : [])], unverifiableAction: 'reject' },
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
  const messages: Record<string, string> = { PLATFORM_EXECUTOR_DISABLED: '平台执行器已停用，请返回修改约定并开放接单。', BRIEF_RESPONSE_INVALID: '未能整理出有效的交付约定，草稿已保留，请重试。', JUDGE_QUORUM_UNAVAILABLE: '裁判暂未达到签名门槛，系统会重试。', JUDGE_CONFIG_INVALID: '裁判配置与链上注册信息不一致，请联系平台。', MODEL_POLICY_VIOLATION: '模型响应与免费调用策略不一致，已停止调用，请联系平台检查。', MODEL_FREE_UNAVAILABLE: '免费生成模型暂不可用，未切换付费模型。请稍后重试。', MODEL_NO_FREE_PROVIDER: '白名单中暂时没有满足零价格与格式要求的模型。', MODEL_UNAVAILABLE: '模型服务尚未配置。', MODEL_DAILY_LIMIT: '今日模型额度已用完，请等待额度恢复；已有交付按原审核规则处理。', MODEL_MINUTE_LIMIT: '模型请求较频繁，请稍后重试。', MODEL_ACCESS_UNAVAILABLE: '模型服务凭证或访问权限不可用，请联系平台检查。', MODEL_CATALOG_UNAVAILABLE: '无法核对免费模型价格，本次未调用生成服务。', QUICKNODE_CONFIG_INVALID: '链上数据服务配置无效，请联系平台检查。', SIGNER_GAS_INSUFFICIENT: '平台交易账户 gas 不足，原操作已保留，补足后会继续；请勿重复创建任务。', BUDGET_AMOUNT_INVALID: '充值及累计授权额度为 0.01–5 test USDC，最多 6 位小数。', SOURCE_NOT_ALLOWED: '目前支持 docs.monad.xyz 的公开资料，请调整来源。', INVALID_BLOCK_RANGE: '请选择不超过 1,001 个已确认区块的范围。', BUDGET_UNAVAILABLE: '预算不足或授权已到期，请先检查预算设置。', SIGNATURE_INVALID: '钱包签名不匹配或已失效，请重新登录。', REQUEST_CONFLICT: '该操作编号已绑定其他内容，请恢复原操作。', RATE_LIMIT: '操作较频繁，请稍后重试。', SPONSOR_DAILY_LIMIT: '今日平台 gas 赞助额度不足，本次未发布，草稿已保留。请在额度恢复后重新确认发布。', SPONSOR_TX_GAS_LIMIT: '本次操作超出单笔 gas 上限，尚未发布，请联系平台检查。', SPONSOR_FEE_LIMIT: '当前网络费率超出平台上限，尚未发布，请稍后重试。', SPONSOR_LIMIT: '平台 gas 赞助暂不可用，请稍后重试。', WRONG_DELEGATION: '此账户尚未启用受支持的智能账户，请使用钱包操作。', INTENT_EXPIRED: '该授权计划已过期，请重新准备。', USER_ACTION_REQUIRED: '需要 Owner 钱包处理当前任务，请查看任务详情。' };
  return Object.entries(messages).find(([code]) => message.includes(code))?.[1] ?? '操作尚未完成。请稍后重试原操作；如仍失败，请查看执行记录。';
}
