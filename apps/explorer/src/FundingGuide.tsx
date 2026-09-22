import React, { useState } from 'react';
import { formatUnits } from 'viem';
import { t as tr } from './i18n';

export function FundingGuide({ owner, account, refresh }: { owner: string; account?: any; refresh?(): Promise<void> }) {
  const [message,setMessage]=useState('');const [busy,setBusy]=useState(false);
  return <section id="funding-guide" tabIndex={-1} className="funding-guide" aria-labelledby="funding-title">
    <h2 id="funding-title">{tr('领取测试币')}</h2>
    <p>{tr('复制下面的账户地址，分别领取手续费所需的 MON 和任务奖励所需的 USDC。平台只提供指引，不发放或代领测试币。')}</p>
    <label htmlFor="funding-address">{tr('你的收款地址')}</label><div className="funding-address"><input id="funding-address" value={owner} readOnly onFocus={e=>e.target.select()}/><button className="button subtle" onClick={()=>void navigator.clipboard.writeText(owner).then(()=>setMessage('收款地址已复制。')).catch(()=>setMessage('复制未完成，请选中地址手动复制。'))}>{tr('复制地址')}</button></div>
    <ol><li><a href="https://faucet.monad.xyz/" target="_blank" rel="noreferrer">{tr('打开 Monad 水龙头')}</a><p>{tr('粘贴收款地址，按页面提示领取测试 MON。')}</p></li><li><a href="https://faucet.circle.com/" target="_blank" rel="noreferrer">{tr('打开 Circle 水龙头')}</a><p>{tr('选择 USDC 和 Monad Testnet，粘贴同一地址并完成页面验证。到账后回到这里充值任务预算。')}</p></li></ol>
    <p>{tr('账户余额：')}{account ? `${formatUnits(BigInt(account.monBalance??'0'),18)} MON · ${formatUnits(BigInt(account.walletBalance??'0'),6)} test USDC` : tr('正在读取…')}</p>
    {refresh&&<button className="button subtle" disabled={busy} onClick={()=>{setBusy(true);void refresh().then(()=>setMessage('余额已刷新。')).catch(()=>setMessage('暂时无法刷新余额，请稍后重试。')).finally(()=>setBusy(false));}}>{busy?tr('正在读取…'):tr('我已领取，刷新余额')}</button>}
    <p role="status" aria-live="polite">{tr(message)}</p><small>{tr('测试币没有真实货币价值。领取额度、等待时间和验证码以水龙头页面为准。')}</small>
  </section>;
}
