import React from 'react';
import { t as tr } from './i18n';

export function AccountSetup({ account, onContinue }: { account?: any; onContinue(): void }) {
  const funded = !!account && BigInt(account.budget?.vaultBalance ?? '0') >= 10000n;
  const tokensReceived = !!account && BigInt(account.monBalance ?? '0') > 0n && BigInt(account.walletBalance ?? '0') > 0n;
  return <section className="account-setup" aria-labelledby="account-setup-title">
    <h2 id="account-setup-title">{funded ? tr('任务预算已准备') : tr('账户已就绪，接下来准备任务预算')}</h2>
    <p>{funded ? tr('返回任务页面，查看计划并确认奖励后发布。') : tr('先领取测试币，再将 USDC 充值到任务预算。创建账户本身不会自动充值。')}</p>
    <ol>
      <li data-complete="true"><strong>{tr('1 · 创建账户')}</strong><span>{tr('已完成')}</span></li>
      <li data-complete={tokensReceived || funded}><strong>{tr('2 · 领取测试币')}</strong><span>{tokensReceived || funded ? tr('已到账') : tr('使用下方链接领取 MON 和 USDC')}</span></li>
      <li data-complete={funded}><strong>{tr('3 · 充值任务预算')}</strong><span>{funded ? tr('已完成') : tr('到账后，在下方填写金额并确认充值')}</span></li>
    </ol>
    {!account && <p role="status">{tr('正在读取账户余额；你可以先复制地址领取测试币。')}</p>}
    <div className="platform-actions"><button className="button primary" onClick={()=>{
      if(funded){onContinue();return;}
      const target=document.getElementById(tokensReceived?'budget-operation':'funding-guide');
      target?.scrollIntoView({block:'start'});target?.focus({preventScroll:true});
    }}>{funded ? tr('返回并发布任务') : tokensReceived ? tr('去充值任务预算') : tr('去领取测试币')}</button>
    {!funded && <button className="text-button" onClick={onContinue}>{tr('稍后充值，先准备任务')}</button>}</div>
  </section>;
}

export function BudgetReminder({ account, onSetup }: { account?: any; onSetup(): void }) {
  if (!account || BigInt(account.budget?.vaultBalance ?? '0') >= 10000n) return null;
  return <section className="platform-welcome budget-reminder" aria-label={tr('准备任务预算')}>
    <div><h2>{tr('发布前，还需准备任务预算')}</h2><p>{tr('账户已创建。领取测试 MON 和 USDC，再充值任务预算；现在也可以先填写任务草稿。')}</p></div>
    <button className="button primary" onClick={onSetup}>{tr('准备任务预算')}</button>
  </section>;
}
