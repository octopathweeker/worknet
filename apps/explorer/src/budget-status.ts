export type TaskBudget = {
  active: boolean; paused: boolean; effectiveActive: boolean;
  validAfter: string; validUntil: string; vaultBalance: string;
  maxPerTask: string; newCommitmentCapacity: string;
};

// Match the platform's one-hour execution deadline plus ten-minute review window.
export function taskBudgetIssue(budget: TaskBudget | null | undefined, reward: string, now = Math.floor(Date.now() / 1000)): string | undefined {
  if (budget === undefined) return '正在同步预算，请稍候。';
  if (budget === null) return '尚未准备任务预算，请先充值并授权。';
  if (budget.paused) return '预算账户已暂停，请使用 Owner 钱包解除暂停。';
  if (BigInt(budget.vaultBalance) < BigInt(reward)) return '预算余额不足以支付本任务奖励，请补足差额。';
  if (!budget.active) return '付款授权未启用或已撤销，可使用已有余额重新授权，无需充值。';
  if (BigInt(budget.validUntil) <= BigInt(now)) return '付款授权已过期，已有余额仍在，请重新授权，无需充值。';
  if (BigInt(budget.validAfter) > BigInt(now)) return '付款授权尚未生效，请在生效后发布。';
  if (BigInt(budget.validUntil) <= BigInt(now + 4200)) return '付款授权剩余时间不足以覆盖任务与审核，请重新授权。';
  if (BigInt(budget.maxPerTask) < BigInt(reward)) return '本任务奖励超过单笔授权上限，请调整付款授权。';
  if (BigInt(budget.newCommitmentCapacity) < BigInt(reward)) return '剩余付款授权额度不足，已有余额仍在，请重新授权。';
  return undefined;
}

export function renewalAmount(balance: string | undefined): string | undefined {
  const units = BigInt(balance ?? '0');
  if (units < 10000n) return undefined;
  return (units > 5000000n ? 5000000n : units).toString();
}

/** Publishing can prepare payment permission itself when the deposited funds cover the reward. */
export function publicationBudgetIssue(budget: TaskBudget | null | undefined, reward: string): string | undefined {
  if (budget === undefined) return '正在同步预算，请稍候。';
  if (budget === null || BigInt(budget.vaultBalance) < BigInt(reward)) return '预算余额不足以支付本任务奖励，请补足差额。';
  if (budget.paused) return '预算账户已暂停，请使用 Owner 钱包解除暂停。';
  return undefined;
}
