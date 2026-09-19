import { Money } from './components';
import { parseBudgetAmount } from './budget-amount';

type Props = {
  account: any; owner: string; operator?: string; amount: string; pending: { amount: string } | undefined; busy: boolean; checking: boolean; progress: string;
  hasActiveTasks: boolean; setAmount(value: string): void; recharge(preferWallet?: boolean): void; cancel(): void; withdraw(): void; revoke(): void;
};
export function BudgetPanel({ account, owner, operator, amount, pending, busy, checking, progress, hasActiveTasks, setAmount, recharge, cancel, withdraw, revoke }: Props) {
  let units: string | undefined; try { units = parseBudgetAmount(amount); } catch { /* Show limits without manufacturing a valid amount. */ }
  const invalidPending = !!pending && !units;
  const sponsored = account?.accountMode === 'metamask-7702';
  const disabled = busy || checking || !account;
  return <section className="simple-budget">
    <div className="budget-overview"><span>预算余额</span><strong><Money amount={account?.budget?.vaultBalance}/><small>test USDC</small></strong>
      {account?.budget && account.budget.vaultBalance !== account.budget.newCommitmentCapacity && <p>当前可用于新任务 <Money amount={account.budget.newCommitmentCapacity}/> test USDC，受付款授权额度限制。</p>}
    </div>
    <form className="recharge-form" onSubmit={e => { e.preventDefault(); if (invalidPending) cancel(); else recharge(); }}>
      <div className="recharge-heading"><h2>{pending ? '继续充值' : '充值'}</h2><span>钱包余额 <Money amount={account?.walletBalance}/></span></div>
      <label htmlFor="recharge-amount">充值金额</label>
      <div className="recharge-input"><input id="recharge-amount" value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" readOnly={!!pending || checking || busy} aria-describedby="recharge-hint"/><span>test USDC</span></div>
      <p className="recharge-hint" id="recharge-hint">{invalidPending ? '上次填写的金额超出范围，请重新填写。' : pending ? '上次充值尚未完成，继续会接着原操作处理。' : '每次 0.01–5 test USDC'}{!pending && <span>{sponsored ? '平台代付手续费' : '手续费由钱包支付'}</span>}</p>
      <button className="button primary recharge-submit" type="submit" disabled={disabled}>{checking ? '正在核对上次充值…' : busy ? progress || '处理中…' : invalidPending ? '重新填写' : pending ? '继续充值' : '充值'}</button>
      {units && <p className="recharge-consent">同时更新任务付款授权：24 小时内累计最多 <Money amount={units}/>，单笔最多 {BigInt(units) < 200000n ? <Money amount={units}/> : '0.20'} test USDC。</p>}
      {hasActiveTasks && <p className="recharge-notice">你还有进行中的任务；更新授权后，这些任务可能需要你手动审核。</p>}
      {pending && !invalidPending && <button className="text-button recharge-cancel" type="button" disabled={disabled} onClick={cancel}>取消本次充值</button>}
      <details className="recharge-options"><summary>充值说明</summary><p>请按钱包提示确认。完成后资金进入你的独立预算账户，用于你确认发布的任务。</p><p>普通钱包可能需要分次确认。关闭页面后可继续原操作；已发出的交易不会因取消页面操作而撤回。</p>{sponsored && <button type="button" className="text-button" disabled={disabled || !units} onClick={() => recharge(true)}>改用钱包支付手续费</button>}</details>
    </form>
    <details className="budget-management"><summary>资金与授权管理</summary><dl><dt>预算账户余额</dt><dd><Money amount={account?.budget?.vaultBalance}/> test USDC</dd><dt>授权到期</dt><dd>{account?.budget?.validUntil ? new Date(Number(account.budget.validUntil) * 1000).toLocaleString() : '尚未授权'}</dd></dl><div className="budget-management-actions">{BigInt(account?.budget?.vaultBalance ?? '0') > 0n && <button className="button subtle" disabled={disabled} onClick={withdraw}>提回可提现余额</button>}{account?.budget?.active && <button className="text-button danger" disabled={disabled} onClick={revoke}>停止自动付款</button>}</div><p>已发布任务的奖励不在可提现余额内。停止自动付款不会取消已发布任务；其审核仍需处理。</p><details className="budget-addresses"><summary>账户地址</summary><dl><dt>钱包</dt><dd>{owner}</dd><dt>预算账户</dt><dd>{account?.vault}</dd><dt>执行授权地址</dt><dd>{operator}</dd></dl></details></details>
    <p className="budget-test-assets">Monad Testnet · 测试资产 <a href="https://faucet.monad.xyz/" target="_blank" rel="noreferrer">领取 MON</a><a href="https://faucet.circle.com/" target="_blank" rel="noreferrer">领取 USDC</a></p>
  </section>;
}
