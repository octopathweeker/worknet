import type { Hex } from 'viem';

// Completion is based on this intent's journal/receipts, never on the current balance.
export async function walletPaymentComplete(journal: any, callCount: number | undefined, receipt: (hash: Hex) => Promise<{ status: string } | undefined>): Promise<boolean> {
  if (journal?.complete) return true;
  if (!callCount || journal?.mode !== 'sequential' || journal.steps?.length !== callCount || !journal.steps.every((step: any) => step?.hash && !step.sending)) return false;
  const receipts = await Promise.all(journal.steps.map((step: any) => receipt(step.hash)));
  return receipts.every(r => r?.status === 'success');
}
export function paymentMethod(hasCommand: boolean, hasSignature: boolean, hasWalletJournal: boolean, sponsoredAccount: boolean, preferWallet = false): 'sponsor' | 'wallet' {
  // An already-started route wins over preferences: never replay a sponsored deposit in a wallet.
  if (hasCommand || hasSignature) return 'sponsor';
  if (hasWalletJournal || preferWallet) return 'wallet';
  return sponsoredAccount ? 'sponsor' : 'wallet';
}
