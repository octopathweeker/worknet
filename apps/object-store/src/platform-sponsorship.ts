import { parseEther } from 'viem';

export function dailyGasLimit(value = '2'): bigint {
  if (!/^(?:0\.[0-9]{1,2}|[1-5](?:\.[0-9]{1,2})?)$/.test(value)) throw new Error('INVALID_GAS_BUDGET');
  const limit = parseEther(value);
  if (limit <= 0n || limit > parseEther('5')) throw new Error('INVALID_GAS_BUDGET');
  return limit;
}

export function sponsorshipBudget(spent: bigint, limit: bigint, now = new Date()) {
  return { day: now.toISOString().slice(0, 10), spentWei: spent.toString(), limitWei: limit.toString(), remainingWei: (spent < limit ? limit - spent : 0n).toString(), resetsAt: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) };
}
