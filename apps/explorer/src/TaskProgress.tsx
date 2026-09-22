import React from 'react';
import { Icon } from './components';
import { t as tr, locale } from './i18n';

export type ProgressUpdate = { id: string; summary: string; percent: number | null; createdAt: number };

export function TaskProgress({ updates, attempt, active, leaseExpiresAt }: {
  updates: ProgressUpdate[]; attempt: string; active: boolean; leaseExpiresAt?: string;
}) {
  const latest = updates[0];
  const stale = active && latest && Date.now() - latest.createdAt > 5 * 60_000;
  const expired = active && leaseExpiresAt && Number(leaseExpiresAt) * 1000 <= Date.now();
  const timestamp = (update: ProgressUpdate) => <time dateTime={new Date(update.createdAt).toISOString()}>{new Date(update.createdAt).toLocaleString(locale())}</time>;
  return <section className="task-progress" aria-label={tr('Agent 执行进度')}>
    <div className="task-progress-heading"><h2>{tr('Agent 执行进度')}</h2><span>{tr('执行轮次')} {attempt}</span></div>
    <p className="task-progress-note">{tr('由执行 Agent 上报，进度估计不代表审核通过或已结算。')}</p>
    <div aria-live="polite" aria-atomic="true">
      {latest ? <>
        <div className="task-progress-meta"><span>{tr('最近上报')} {timestamp(latest)}</span>{latest.percent !== null && <strong>{latest.percent}%</strong>}</div>
        {latest.percent !== null && <progress max={100} value={latest.percent} aria-label={tr('Agent 自报完成进度')}/>}
        <p className="task-progress-summary">{latest.summary}</p>
      </> : <p>{tr(active ? 'Agent 尚未上报进度，收到后会自动显示。' : '本轮没有进度上报记录。')}</p>}
    </div>
    {expired ? <p className="task-progress-note">{tr('执行租约已到期，等待任务状态同步。')}</p> : stale ? <p className="task-progress-note">{tr('超过 5 分钟未收到新进度；Agent 可能仍在执行。')}</p> : null}
    {updates.length > 1 && <details><summary>{tr('查看进度历史（最近 20 条）')}<Icon name="down" size={14}/></summary><ol>{updates.slice(1).map(update => <li key={update.id}><div className="task-progress-meta">{timestamp(update)}{update.percent !== null && <span>{update.percent}%</span>}</div><p className="task-progress-summary">{update.summary}</p></li>)}</ol></details>}
  </section>;
}
