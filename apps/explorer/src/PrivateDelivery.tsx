import React, { useEffect, useState } from 'react';
import { type DeliveryConfig } from '@agent-task/privacy';
import { unlockDelivery } from './mera-account';
import { settlementMoney } from './settlement';
import { t as tr } from './i18n';

export function PrivateDelivery({ result, delivery, canUnlock = false }: { result: any; delivery?: DeliveryConfig | undefined; canUnlock?: boolean }) {
  const [output,setOutput]=useState<any>();const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  useEffect(()=>{setOutput(undefined);setError('');},[result.taskId,result.attempt,result.output.commitment]);
  useEffect(()=>{const lock=()=>setOutput(undefined);window.addEventListener('pagehide',lock);return()=>window.removeEventListener('pagehide',lock);},[]);
  return <article className="deliverable private-delivery"><div className="deliverable-head"><h2>{tr('私有交付')}</h2><span className="pill">{tr('按任务独立加密')}</span></div>
    {!output ? <><p>{canUnlock?tr('交付已加密保存。使用发布任务的通行密钥，在本设备解锁查看。'):tr('交付已加密保存，发布者可使用自己的通行密钥解锁。')}</p>{canUnlock&&delivery&&<button className="button primary" disabled={busy} onClick={()=>{setBusy(true);setError('');void unlockDelivery(delivery,result).then(setOutput).catch(()=>setError('无法解锁。请使用发布该任务的通行密钥，并确认设备支持 PRF。')).finally(()=>setBusy(false));}}>{busy?tr('正在解锁…'):tr('使用通行密钥查看')}</button>}</> : <div className="result-document">{output.mode==='llm'?<><p className="research-summary">{output.summary}</p>{output.findings?.map((finding:any,index:number)=><section className="finding" key={index}><h3>{finding.title}</h3><p>{finding.claim}</p><blockquote>{finding.quote}</blockquote></section>)}</>:<div className="analysis-result"><div><span>{tr('转账次数')}</span><strong>{output.eventCount}</strong></div><div><span>{tr('转账总额')}</span><strong>{settlementMoney(output.totalAmountBaseUnits)}<small>test USDC</small></strong></div></div>}<button className="button subtle" onClick={()=>setOutput(undefined)}>{tr('锁定交付')}</button></div>}
    {error&&<p role="alert">{tr(error)}</p>}<p className="taker-explanation">{tr('执行器与获授权的审核服务会在处理阶段读取交付内容；公开记录不包含报告明文。解锁内容不会保存到浏览器存储。')}</p>
  </article>;
}
