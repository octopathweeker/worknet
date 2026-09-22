import { MeraActivity } from './MeraActivity';
import { FundingGuide } from './FundingGuide';
import {t as tr,locale} from './i18n';
import { Money } from './components';
import { parseBudgetAmount } from './budget-amount';


type Props = {
  refresh?(): Promise<void>; account: any; owner: string; operator?: string; amount: string; pending: { amount: string; mode?: 'recharge' | 'authorize' } | undefined; busy: boolean; checking: boolean; progress: string;
  hasActiveTasks: boolean; setAmount(value: string): void; recharge(): void; cancel(): void; withdraw(): void; revoke(): void;
};
export function BudgetPanel({ refresh, account, owner, operator, amount, pending, busy, checking, progress, hasActiveTasks, setAmount, recharge, cancel, withdraw, revoke }: Props) {
  let units: string | undefined; try { units = parseBudgetAmount(amount); } catch { /* Show limits without manufacturing a valid amount. */ }
  const invalidPending = !!pending && !units;
  const renewing = pending?.mode === 'authorize';
  const disabled = busy || checking || !account;
  return <section className="simple-budget">
    <div className="budget-overview"><span>{tr("预算余额")}</span><strong><Money amount={account?.budget?.vaultBalance}/><small>test USDC</small></strong>
    </div>
    <p className="budget-publish-hint">{tr("余额充足即可发布任务。需要账户确认时，平台会在发布过程中提示。")}</p>
    <FundingGuide owner={owner} account={account} {...(refresh ? {refresh} : {})}/>
    <form id="budget-operation" tabIndex={-1} className="recharge-form" onSubmit={e => { e.preventDefault(); if (invalidPending) cancel(); else recharge(); }}>
      <div className="recharge-heading"><h2>{renewing ? tr("完成账户确认") : pending ? tr("继续充值") : tr("充值")}</h2><span>{tr("账户余额")}<Money amount={account?.walletBalance}/></span></div>
      <label htmlFor="recharge-amount">{renewing ? tr("授权额度") : tr("充值金额")}</label>
      <div className="recharge-input"><input id="recharge-amount" value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" readOnly={!!pending || checking || busy} aria-describedby="recharge-hint"/><span>test USDC</span></div>
      <p className="recharge-hint" id="recharge-hint">{invalidPending ? tr("上次填写的金额超出范围，请重新填写。") : renewing ? tr("上次账户操作尚未完成，也可以返回任务继续发布。") : pending ? tr("上次充值尚未完成，继续会接着原操作处理。") : tr("每次 0.01–5 test USDC")}{!pending && <span>{tr("手续费由你的账户承担，请先领取测试 MON")}</span>}</p>
      <button className="button primary recharge-submit" type="submit" disabled={disabled}>{checking ? tr("正在核对上次预算操作…") : busy ? tr(progress) || tr("处理中…") : invalidPending ? tr("重新填写") : renewing ? tr("完成账户确认") : pending ? tr("继续充值") : tr("充值")}</button>
      {units && <p className="recharge-consent">{renewing ? tr("更新任务付款授权：24 小时内累计最多") : tr("同时更新任务付款授权：24 小时内累计最多")}<Money amount={units}/>{tr("，单笔最多")}{BigInt(units) < 200000n ? <Money amount={units}/> : '0.20'} test USDC。</p>}
      {hasActiveTasks && <p className="recharge-notice">{tr("你还有进行中的任务；更新授权后，这些任务可能需要你手动审核。")}</p>}
      {pending && !invalidPending && <button className="text-button recharge-cancel" type="button" disabled={disabled} onClick={cancel}>{renewing ? tr("取消本次授权") : tr("取消本次充值")}</button>}
      {!renewing && <details className="recharge-options"><summary>{tr("充值说明")}</summary><p>{tr("确认后资金进入你的独立预算账户，用于你发布的任务。通行密钥负责账户签名。")}</p><p>{tr("充值包含预算账户初始化、额度批准、存入与任务授权。关闭页面后可继续原操作；已发送的操作不能通过关闭页面撤回。")}</p></details>}
    </form>
    <MeraActivity owner={owner}/>
    <details className="budget-management"><summary>{tr("资金与授权管理")}</summary><dl><dt>{tr("预算账户余额")}</dt><dd><Money amount={account?.budget?.vaultBalance}/> test USDC</dd><dt>{tr("授权到期")}</dt><dd>{account?.budget?.validUntil ? new Date(Number(account.budget.validUntil) * 1000).toLocaleString(locale()) : tr("尚未授权")}</dd></dl><div className="budget-management-actions">{BigInt(account?.budget?.vaultBalance ?? '0') > 0n && <button className="button subtle" disabled={disabled} onClick={withdraw}>{tr("提回可提现余额")}</button>}{account?.budget?.active && <button className="text-button danger" disabled={disabled} onClick={revoke}>{tr("停止自动付款")}</button>}</div><p>{tr("已发布任务的奖励不在可提现余额内。停止自动付款不会取消已发布任务；其审核仍需处理。")}</p><details className="budget-addresses"><summary>{tr("账户地址")}</summary><dl><dt>{tr("Mera 主账户")}</dt><dd>{owner}</dd><dt>{tr("发布任务预算合约")}</dt><dd>{account?.vault}</dd><dt>{tr("平台发布执行器 · 非充值地址")}</dt><dd>{operator}</dd></dl><p>{tr("这里用于发布任务。接单 Agent 的 gas 地址请在“接单 → 执行器 → 账户与充值”查看。不要向平台发布执行器转账。")}</p></details></details>

  </section>;
}
