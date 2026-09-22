import { decodeFunctionData } from 'viem';
import { requesterVaultAbi } from '@agent-task/contracts';
import { publicationBudgetIssue, taskBudgetIssue, type TaskBudget } from './budget-status.js';

export type PublicationAccount = { budget: TaskBudget | null; chainTimestamp: string };

/** Only the on-chain authorizeAgent deadline makes an old wallet operation harmless.
 * The ten-minute sponsor-signature deadline alone does not expire a wallet transaction.
 * Expired authorization reverts, so a late old batch cannot replace the new permission.
 */
export function expiredBudgetPermission(prepared: any, chainTimestamp: string): boolean {
  try {
    const last = prepared.calls?.at(-1);
    if (!last || last.target.toLowerCase() !== prepared.vault.toLowerCase()) return false;
    const decoded = decodeFunctionData({ abi: requesterVaultAbi, data: last.callData });
    return decoded.functionName === 'authorizeAgent' && decoded.args[1].validUntil > 0n && decoded.args[1].validUntil <= BigInt(chainTimestamp);
  } catch { return false; }
}

type PublicationFlow = {
  reward: string;
  recover(): Promise<boolean>;
  readAccount(): Promise<PublicationAccount>;
  preparePayment(): Promise<void>;
  publish(): Promise<void>;
  assertCurrent(): void;
  wait(): Promise<void>;
};

/** Recover the original publication first; wallet success alone never proves readiness. */
export async function confirmPublication(flow: PublicationFlow): Promise<void> {
  flow.assertCurrent();
  const recovered = await flow.recover(); flow.assertCurrent();
  if (recovered) return;
  let account = await flow.readAccount(); flow.assertCurrent();
  const check = () => {
    const blocked = publicationBudgetIssue(account.budget, flow.reward);
    if (blocked) throw new Error(blocked);
    return !taskBudgetIssue(account.budget, flow.reward, Number(account.chainTimestamp));
  };
  if (!check()) {
    await flow.preparePayment(); flow.assertCurrent();
    for (let i = 0; i < 15; i++) {
      account = await flow.readAccount(); flow.assertCurrent();
      if (check()) break;
      if (i === 14) throw new Error('钱包确认尚未同步到链上，原任务已保留，请稍后继续发布。');
      await flow.wait(); flow.assertCurrent();
    }
  }
  flow.assertCurrent();
  await flow.publish();
}
