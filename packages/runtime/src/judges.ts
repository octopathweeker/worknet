import type { Address, Hex } from 'viem';
import { publicFailure } from './errors.js';
import { clientRequestId, type ResultManifest, type TaskSpec } from '@agent-task/protocol';
import type { RuntimeConfig } from './config.js';

export const JUDGE_QUORUM_PROFILE = 'jev.quorum';
export const JUDGE_QUORUM_PROFILE_VERSION = '1.0.0';
const VERDICT_TYPE = [
  { name: 'taskId', type: 'uint256' },
  { name: 'attempt', type: 'uint64' },
  { name: 'resultHash', type: 'bytes32' },
  { name: 'completionBps', type: 'uint16' },
] as const;

export interface VerdictTypedData {
  domain: { name: 'WorknetJudge'; version: '1'; chainId: number; verifyingContract: Address };
  types: { Verdict: typeof VERDICT_TYPE };
  primaryType: 'Verdict';
  message: { taskId: bigint; attempt: bigint; resultHash: Hex; completionBps: number };
}

export function verdictTypedData(chainId: number, manager: Address, taskId: bigint, attempt: bigint, resultHash: Hex, completionBps: number): VerdictTypedData {
  return {
    domain: { name: 'WorknetJudge', version: '1', chainId, verifyingContract: manager },
    types: { Verdict: VERDICT_TYPE },
    primaryType: 'Verdict',
    message: { taskId, attempt, resultHash, completionBps },
  };
}

export interface Verdict { judge: Address; completionBps: number; signature: Hex; }

export interface JudgeEvaluationRequest {
  spec: TaskSpec; result: ResultManifest; taskId: string; attempt: string; resultHash: Hex; specHash: Hex;
}

function parseVerdict(body: unknown, url: string): Verdict {
  if (!body || typeof body !== 'object') throw new Error(`JUDGE_RESPONSE_INVALID:${url}`);
  const { judge, completionBps, signature } = body as Record<string, unknown>;
  if (typeof judge !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(judge) || typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature) || !Number.isSafeInteger(completionBps) || (completionBps as number) < 0 || (completionBps as number) > 10000) throw new Error(`JUDGE_RESPONSE_INVALID:${url}`);
  return { judge: judge as Address, completionBps: completionBps as number, signature: signature as Hex };
}

async function queryJudge(url: string, payload: JudgeEvaluationRequest): Promise<Verdict> {
  const response = await fetch(new URL('evaluate', url), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`JUDGE_HTTP_${response.status}:${url}`);
  return parseVerdict(await response.json(), url);
}

export async function collectVerdicts(judgeUrls: string[], payload: JudgeEvaluationRequest, threshold: number): Promise<Verdict[]> {
  if (judgeUrls.length === 0) throw new Error('JUDGE_QUORUM_UNAVAILABLE');
  const settled = await Promise.allSettled(judgeUrls.map(url => queryJudge(url, payload)));
  const verdicts: Verdict[] = [];
  for (const result of settled) if (result.status === 'fulfilled') verdicts.push(result.value);
  if (verdicts.length < threshold) {
    const reasons = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => publicFailure(result.reason)).join('; ');
    throw new Error(`JUDGE_QUORUM_UNAVAILABLE:${reasons}`);
  }
  return verdicts;
}

export function medianBps(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1]!;
}

export function quorumTask(config: RuntimeConfig, logicalKey: string, deadline: number, quality: 'complete' | 'partial' = 'complete'): TaskSpec {
  return {
    protocol: 'agent-task/0.1', settlementChainId: String(config.chainId), taskManager: config.manager.toLowerCase(), requester: config.vault.toLowerCase(), clientRequestId: clientRequestId(logicalKey),
    capability: 'general.deliverable', capabilityVersion: '1.0.0', title: '非标准交付物完成度评审',
    instructions: '交付一份 Monad 生态简介：说明 Monad 的并行执行与 单slots 最终性，并给出一段面向开发者的上手建议。',
    input: { quality },
    outputSchema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string', minLength: 1, maxLength: 5000 } } },
    reward: { token: config.token.toLowerCase(), amountBaseUnits: '50000' },
    execution: { taskDeadline: deadline, claimLeaseSeconds: 180, reviewWindowSeconds: 300 },
    verification: { profile: JUDGE_QUORUM_PROFILE, profileVersion: JUDGE_QUORUM_PROFILE_VERSION, criteria: ['内容覆盖并行执行与最终性两个主题', '每项表述准确且连贯', '包含面向开发者的可执行建议'], unverifiableAction: 'reject' },
  };
}

export function quorumResult(config: RuntimeConfig, taskId: bigint, attempt: bigint, worker: Address, specHash: Hex, quality: 'complete' | 'partial'): ResultManifest {
  const summary = quality === 'complete'
    ? 'Monad 通过并行执行让普通节点也能跑满吞吐，并以单 slot 最终性让交易在产块的同时即告确定。开发者上手建议：从 testnet RPC 与文档的 guides 开始，先跑一笔最小转账感受亚秒确认，再尝试把现有 EVM 合约直接部署过来。'
    : 'Monad 很快。它执行很快，确认也快。开发者可以试试。';
  return {
    protocol: 'agent-task/0.1', settlementChainId: String(config.chainId), taskManager: config.manager.toLowerCase(),
    taskId: taskId.toString(), attempt: attempt.toString(), worker: worker.toLowerCase(), specHash,
    output: { summary }, artifacts: [], provenance: { toolVersion: 'demo/0.1' },
  };
}
