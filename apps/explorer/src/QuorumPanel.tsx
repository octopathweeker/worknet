import { t as tr } from './i18n';
import { short } from './components';
import { settlementMoney } from './settlement';

type Settlement = { completionBps: number; workerAmount: string; refundAmount: string; transactionHash: string };
export function QuorumPanel({ evidence, settlement, ended = false }: { evidence?: any; settlement?: Settlement | undefined; ended?: boolean }) {
  if(evidence?.profile!=='jev.quorum'&&!settlement)return null;
  return <section className="quorum-panel" aria-label={tr('裁判评分与分账')}>
    <h3>{tr('裁判评分与分账')}</h3>
    <p role="status">{settlement ? tr('链上分账已确认') : ended ? tr('本轮已结束；以下评分不代表实际付款，请核对链上记录。') : evidence?.verdict==='scored' ? tr('签名已收齐，等待链上结算') : tr('裁判暂未达到签名门槛，系统会重试。')}</p>
    {(evidence?.verdicts??[]).map((v:any)=><p key={v.judge}><span title={v.judge}>{short(v.judge)}</span><strong>{(v.completionBps/100).toFixed(2)}%</strong></p>)}
    {settlement&&<><dl><dt>{tr('最终完成度')}</dt><dd>{(settlement.completionBps/100).toFixed(2)}%</dd><dt>{tr('实际付款')}</dt><dd>{settlementMoney(settlement.workerAmount)} test USDC</dd><dt>{tr('退回任务预算')}</dt><dd>{settlementMoney(settlement.refundAmount)} test USDC</dd></dl><a href={`https://testnet.monadexplorer.com/tx/${settlement.transactionHash}`} target="_blank" rel="noreferrer">{tr('查看分账交易')}</a></>}
    <p className="muted">{tr('完成度取有效评分的中位数；偶数份评分取较低中位数。部分付款不表示全部验收通过。')}</p>
  </section>;
}
export function QuorumTerms() {
  return <p className="quorum-terms">{tr('本任务由多名裁判评分，按完成度中位数付款，剩余奖励退回任务预算。裁判不足时自动重试并尝试拒绝当前交付；若审核超时，原有全额付款规则仍适用。Owner 也可手动接受或拒绝。')}</p>;
}
