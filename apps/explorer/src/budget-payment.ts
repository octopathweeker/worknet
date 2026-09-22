import type { Hex } from 'viem';

export type WalletPaymentState = 'complete' | 'settled' | 'unsent' | 'pending' | 'unknown';
type Receipt = (hash: Hex) => Promise<{ status: string } | undefined>;
type BatchStatus = (id: string) => Promise<{ status: number | string; chainId?: string; receipts?: { status: string }[] } | undefined>;

// EIP-5792 status is evidence; the existence of a batch ID or an old send flag is not.
// https://eips.ethereum.org/EIPS/eip-5792#wallet_getcallsstatus
export async function walletPaymentState(journal: any, callCount: number | undefined, receipt: Receipt, batchStatus?: BatchStatus): Promise<WalletPaymentState> {
  if (!journal) return 'unsent';
  if (journal.complete) return 'complete';
  if (journal.mode === 'batch') {
    const id = journal.batchId ?? (journal.sending ? journal.requestId : undefined);
    if (!id) return journal.sending ? 'unknown' : 'unsent';
    let state;
    try { state = await batchStatus?.(id); } catch { return 'unknown'; }
    if (!state || state.chainId && state.chainId.toLowerCase() !== '0x279f') return 'unknown';
    const status = Number(state.status);
    if (state.status === 'CONFIRMED' || status >= 200 && status < 300) return state.receipts?.some(r => r.status === '0x0' || r.status === 'reverted') ? 'settled' : 'complete';
    if (status >= 400 && status < 700) return 'settled';
    if (state.status === 'PENDING' || status >= 100 && status < 200) return 'pending';
    return 'unknown';
  }
  const steps = journal.steps ?? [];
  if (journal.sending || steps.some((step: any) => step?.sending && !step.hash)) return 'unknown';
  const hashes: Hex[] = steps.flatMap((step: any) => step?.hash ? [step.hash] : []);
  if (!hashes.length) return 'unsent';
  let receipts;
  try { receipts = await Promise.all(hashes.map(receipt)); } catch { return 'unknown'; }
  if (receipts.some(r => !r)) return 'pending';
  if (callCount && hashes.length === callCount && steps.length === callCount && receipts.every(r => r?.status === 'success')) return 'complete';
  return 'settled'; // Partial or reverted operation, with no transaction still in flight.
}

// Completion is based on this intent's journal/receipts, never on the current balance.
export async function walletPaymentComplete(journal: any, callCount: number | undefined, receipt: Receipt, batchStatus?: BatchStatus): Promise<boolean> {
  return await walletPaymentState(journal, callCount, receipt, batchStatus) === 'complete';
}
export function paymentMethod(hasCommand: boolean, hasSignature: boolean): 'sponsor' | 'wallet' {
  // Resume an existing signed/submitted intent without changing its payment route.
  if (hasCommand || hasSignature) return 'sponsor';
  // 7702 bytecode proves contract compatibility, not external delegation-signing support.
  // MetaMask blocks raw Delegation typed-data requests for wallet-managed accounts.
  // New intents use wallet-confirmed transactions; no forbidden signature probe is needed.
  return 'wallet';
}
