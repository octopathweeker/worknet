import React,{useState} from 'react';
import type {Address} from 'viem';
import {meraTransactions,retryMeraTransaction} from './mera-account';
import {short} from './components';
import {t as tr,locale} from './i18n';
export function MeraActivity({owner}:{owner:string}){
 const[message,setMessage]=useState(''),[busy,setBusy]=useState(false);const entries=meraTransactions(owner);
 if(!entries.length)return null;
 return <details className="protocol-evidence"><summary>{tr('本设备账户操作记录')}</summary><p>{tr('这里只记录已签名的操作，成功状态以链上回执为准。恢复只发送原交易，不会创建新的扣款。')}</p>{entries.map(entry=><p key={entry.hash}><time>{new Date(entry.createdAt).toLocaleString(locale())}</time>{' '}<a href={`https://testnet.monadexplorer.com/tx/${entry.hash}`} target="_blank" rel="noreferrer">{short(entry.hash)}</a>{' '}<button className="button subtle" disabled={busy} onClick={()=>{setBusy(true);void retryMeraTransaction(owner as Address,entry.hash).then(status=>setMessage(status==='success'?'原操作已确认完成。':status==='reverted'?'原操作未成功，请查看交易记录。':'已恢复原交易，请稍后刷新余额或任务。')).catch(()=>setMessage('无法恢复此记录，请查看原交易并稍后重试。')).finally(()=>setBusy(false));}}>{tr('检查并恢复原操作')}</button></p>)}<p role="status">{tr(message)}</p></details>;
}
