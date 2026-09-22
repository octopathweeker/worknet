export const taskExamples = [
  { title: '研究 Monad 的 Agent 基础设施', goal: '比较 Monad 上的 ERC-8004 身份与 MPP 支付分别解决什么问题，形成有来源引用的研究简报。', kind: 'research', sources: ['https://docs.monad.xyz/guides/erc-8004.md', 'https://docs.monad.xyz/reference/mpp/overview.md'], icon: 'file' },
  { title: '了解最新的 USDC 转账情况', goal: '统计最近 100 个已确认区块中的测试 USDC 转账次数和总金额，给出可复核的结果。', kind: 'analysis', sources: [], icon: 'grid' },
  { title: '梳理钱包的 7702 授权流程', goal: '根据 Monad 官方文档，说明 EIP-7702 钱包授权的流程、适用场景与限制，整理成附来源引用的说明。', kind: 'research', sources: ['https://docs.monad.xyz/developer-essentials/eip-7702.md'], icon: 'wallet' },
] as const;

export const defaultSources = [...taskExamples[0].sources, ...taskExamples[2].sources].join('\n');
export type Intent = { version: 'worknet-intent/1'; objective: string; constraints: string[]; assumptions: string[]; evidenceRequirements: string[] };
export type Agreement = { intent?: Intent; deliverable: string; acceptanceCriteria: string[] };
export type Brief = { status: 'ready'; kind: 'research' | 'analysis' | 'general'; agreement: Agreement } | { status: 'needs_input'; reason: string; questions: string[] } | { status: 'unsupported'; reason: string };
export type TaskDraft = { goal: string; kind: 'research' | 'analysis' | 'general'; sources: string; reward: string; fromBlock: string; toBlock: string; agreement?: Agreement; basis?: string };
export const draftBasis = (draft: Pick<TaskDraft, 'goal' | 'sources' | 'fromBlock' | 'toBlock'>) => JSON.stringify(['intent-v1', draft.goal, draft.sources, draft.fromBlock, draft.toBlock]);
export function clearTaskDraft(): void {
  try { localStorage.removeItem('worknet-platform-draft'); localStorage.removeItem('worknet-goal-draft'); } catch { /* Optional persistence. */ }
}
export const emptyTaskDraft = (): TaskDraft => ({ goal: '', kind: 'general', sources: '', reward: '0.05', fromBlock: '', toBlock: '' });

/** Type-specific inputs must not leak into another task's intent or saved plan. */
export function draftParameters(draft: TaskDraft): { sourceUrls: string[]; fromBlock?: string; toBlock?: string } {
  return draft.kind === 'analysis'
    ? { sourceUrls: [], ...(draft.fromBlock ? { fromBlock: draft.fromBlock } : {}), ...(draft.toBlock ? { toBlock: draft.toBlock } : {}) }
    : { sourceUrls: draft.sources.split(/\s+/).filter(Boolean) };
}
export function asGeneralDraft(draft: TaskDraft): TaskDraft {
  const { agreement: _agreement, basis: _basis, ...input } = draft;
  return { ...input, kind: 'general', fromBlock: '', toBlock: '', sources: draft.kind === 'analysis' ? '' : draft.sources };
}
export function presetDraft(draft: TaskDraft, example: typeof taskExamples[number]): TaskDraft {
  return { ...emptyTaskDraft(), reward: draft.reward, goal: example.goal, kind: example.kind, sources: example.sources.join('\n') };
}

export function taskReward(value: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value.trim())) throw new Error('任务奖励须为 0.01–0.20 test USDC，最多 6 位小数。');
  const [whole, fraction = ''] = value.trim().split('.');
  const units = BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (units < 10000n || units > 200000n) throw new Error('任务奖励须为 0.01–0.20 test USDC，最多 6 位小数。');
  return units.toString();
}

export function readTaskDraft(): TaskDraft {
  const empty = emptyTaskDraft();
  try {
    const stored = localStorage.getItem('worknet-platform-draft');
    if (!stored) return { ...empty, goal: localStorage.getItem('worknet-goal-draft') ?? '' };
    const draft = JSON.parse(stored);
    if (!draft || typeof draft !== 'object') return empty;
    return {
      goal: typeof draft.goal === 'string' ? draft.goal : '',
      kind: draft.flowVersion === 2 && (draft.kind === 'analysis' || draft.kind === 'research') ? draft.kind : 'general',
      sources: typeof draft.sources === 'string' ? draft.sources : '',
      reward: typeof draft.reward === 'string' ? draft.reward : '0.05',
      fromBlock: typeof draft.fromBlock === 'string' ? draft.fromBlock : '',
      toBlock: typeof draft.toBlock === 'string' ? draft.toBlock : '',
      ...(draft.agreement && (!draft.agreement.intent || draft.agreement.intent.version === 'worknet-intent/1' && typeof draft.agreement.intent.objective === 'string' && ['constraints','assumptions','evidenceRequirements'].every(k => Array.isArray(draft.agreement.intent[k]) && draft.agreement.intent[k].length <= 8 && draft.agreement.intent[k].every((v: unknown) => typeof v === 'string' && v.length <= 300))) && typeof draft.agreement.deliverable === 'string' && draft.agreement.deliverable.length <= 1000 && Array.isArray(draft.agreement.acceptanceCriteria) && draft.agreement.acceptanceCriteria.length <= 8 && draft.agreement.acceptanceCriteria.every((c: unknown) => typeof c === 'string' && c.length <= 300) ? { agreement: draft.agreement } : {}),
      ...(typeof draft.basis === 'string' ? { basis: draft.basis } : {}),
    };
  } catch { return empty; }
}
