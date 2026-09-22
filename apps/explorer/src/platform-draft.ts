export const taskExamples = [
  { title: '研究 Monad 的 Agent 基础设施', goal: '比较 Monad 上的 ERC-8004 身份与 MPP 支付分别解决什么问题，形成有来源引用的研究简报。', kind: 'research', sources: ['https://docs.monad.xyz/guides/erc-8004.md', 'https://docs.monad.xyz/reference/mpp/overview.md'], icon: 'file' },
  { title: '了解最新的 USDC 转账情况', goal: '统计最近 100 个已确认区块中的测试 USDC 转账次数和总金额，给出可复核的结果。', kind: 'analysis', sources: [], icon: 'grid' },
  { title: '梳理钱包的 7702 授权流程', goal: '根据 Monad 官方文档，说明 EIP-7702 钱包授权的流程、适用场景与限制，整理成附来源引用的说明。', kind: 'research', sources: ['https://docs.monad.xyz/developer-essentials/eip-7702.md'], icon: 'wallet' },
] as const;

export const defaultSources = [...taskExamples[0].sources, ...taskExamples[2].sources].join('\n');
export type TaskDraft = { goal: string; kind: 'research' | 'analysis'; sources: string; reward: string; fromBlock: string; toBlock: string };

export function readTaskDraft(): TaskDraft {
  const empty: TaskDraft = { goal: '', kind: 'research', sources: defaultSources, reward: '0.05', fromBlock: '', toBlock: '' };
  try {
    const stored = localStorage.getItem('worknet-platform-draft');
    if (!stored) return { ...empty, goal: localStorage.getItem('worknet-goal-draft') ?? '' };
    const draft = JSON.parse(stored);
    if (!draft || typeof draft !== 'object') return empty;
    return {
      goal: typeof draft.goal === 'string' ? draft.goal : '',
      kind: draft.kind === 'analysis' ? 'analysis' : 'research',
      sources: typeof draft.sources === 'string' ? draft.sources : defaultSources,
      reward: typeof draft.reward === 'string' ? draft.reward : '0.05',
      fromBlock: typeof draft.fromBlock === 'string' ? draft.fromBlock : '',
      toBlock: typeof draft.toBlock === 'string' ? draft.toBlock : '',
    };
  } catch { return empty; }
}
