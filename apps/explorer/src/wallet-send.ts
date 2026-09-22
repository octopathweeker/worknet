/** Only explicit pre-broadcast failures release a send lock. Timeouts remain ambiguous. */
export class UnbroadcastTransactionError extends Error {
  constructor(cause:unknown) { super(cause instanceof Error?cause.message:'Account transaction preparation failed',{cause});this.name='UnbroadcastTransactionError'; }
}
export function walletSendFailure(error: unknown): 'rejected' | 'insufficient-funds' | 'not-sent' | undefined {
  const queue: unknown[] = [error]; const seen = new Set<unknown>();
  let notSent=false;
  while (queue.length && seen.size < 16) {
    const entry = queue.shift(); if (!entry || typeof entry !== 'object' || seen.has(entry)) continue;
    seen.add(entry); const e = entry as any;
    if(entry instanceof UnbroadcastTransactionError)notSent=true;
    if (e.code === 4001 || e.name === 'UserRejectedRequestError') return 'rejected';
    const message = [e.shortMessage, e.message, e.details].filter(v => typeof v === 'string').join(' ');
    if (e.name === 'InsufficientFundsError' || /insufficient funds|insufficient balance|exceeds (?:the )?(?:transaction sender )?account balance|余额不足/i.test(message)) return 'insufficient-funds';
    queue.push(e.cause, e.error, e.data?.originalError);
  }
  if(notSent)return 'not-sent';
}

export function resetUnsentWalletJournal(journal: any, confirmed: boolean, hasPending: boolean) {
  if (!confirmed) throw new Error('请先在钱包中核对：原操作未发送成功，且没有待处理交易。');
  if (journal.hash) throw new Error('已有交易 hash，请先恢复原交易，不能清除后重复发送。');
  if (hasPending) throw new Error('当前钱包仍有待处理交易，请先在钱包中处理后再恢复。');
  return { ...journal, sending: false, resetAt: Date.now(), resetReason: 'owner-confirmed-not-sent' };
}
