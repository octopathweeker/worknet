import React from 'react';
import { settlementMoney } from './settlement';
import { t as tr } from './i18n';

export function ProtocolEvidence({result,payments=[],storageUrl}:{result?:any;payments?:any[];storageUrl?:string}) {
  const ref=result?.agentRef;
  if(!ref&&!payments.length)return null;
  return <details className="protocol-evidence"><summary>{tr('身份与服务凭证')}</summary>
    {ref&&<dl><dt>ERC-8004</dt><dd>{tr('交付关联身份：')}#{ref.agentId} · {ref.chainId}</dd><dt>{tr('注册表')}</dt><dd>{ref.registry}</dd></dl>}
    {result?.artifacts?.filter((a:any)=>['application/vnd.worknet.identity+json','application/vnd.worknet.tool-purchase+json'].includes(a.mediaType)).map((a:any)=>{
      let path:string|undefined;try{const u=new URL(a.uri);const storageOrigin=storageUrl?new URL(storageUrl).origin:location.origin;if((u.origin===location.origin||u.origin===storageOrigin)&&/^0x[0-9a-f]{64}$/.test(a.hash)&&u.pathname===`/objects/${a.hash}`&&!u.search&&!u.hash)path=u.pathname;}catch{/* Invalid links are omitted. */}
      return path?<p key={a.hash}><a href={path} target="_blank" rel="noreferrer">{a.mediaType.includes('identity')?tr('查看身份核验快照'):tr('查看采购凭证')}</a></p>:null;
    })}
    {payments.map((payment,index)=><div key={payment.transactionHash??index}><p>MPP · {tr(payment.status==='delivered'?'工具结果已取得':payment.status==='paid'?'已付款，结果待恢复':payment.status==='reverted'?'付款交易未成功':'额度已预留，尚未确认付款')}</p><p>{tr(['paid','delivered'].includes(payment.status)?'平台已付工具费：':payment.status==='reverted'?'原报价（未支付）：':'工具费预留：')}{settlementMoney(payment.amountBaseUnits)} test USDC</p>{payment.transactionHash&&/^0x[0-9a-f]{64}$/.test(payment.transactionHash)&&<a href={`https://testnet.monadexplorer.com/tx/${payment.transactionHash}`} target="_blank" rel="noreferrer">{tr('查看工具付款交易')}</a>}</div>)}
    {payments.length>0&&<p>{tr('工具费不扣任务奖励或你的预算余额。付款成功不代表交付已通过审核。')}</p>}
  </details>;
}
