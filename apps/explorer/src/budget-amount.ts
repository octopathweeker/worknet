import { parseUnits } from 'viem';

export const budgetAmountHelp = '充值及累计授权额度为 0.01–5 test USDC，最多 6 位小数。';
export function parseBudgetAmount(value: string): string {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text)) throw new Error(budgetAmountHelp);
  const units = parseUnits(text, 6);
  if (units < 10000n || units > 5000000n) throw new Error(budgetAmountHelp);
  return units.toString();
}
