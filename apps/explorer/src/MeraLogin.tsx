import React, { useEffect, useRef } from 'react';
import { t as tr } from './i18n';

export function MeraLogin({ open, busy, error, onChoose, onClose }: { open: boolean; busy: boolean; error: string; onChoose(mode:'create'|'signin'): void; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if(open && !dialog.current?.open) dialog.current?.showModal(); if(!open)dialog.current?.close(); },[open]);
  return <dialog ref={dialog} className="mera-login" aria-labelledby="mera-login-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
    <h2 id="mera-login-title">{tr('你的 Worknet 账户')}</h2>
    <p>{tr('使用通行密钥创建或恢复账户，无需安装钱包插件或记住助记词。')}</p>
    <p className="mera-attribution">{tr('通行密钥账户由')}{' '}<a href="https://mera.category.xyz/getting-started/" target="_blank" rel="noreferrer">Mera</a>{' '}{tr('提供技术支持。')}</p>
    <div className="platform-actions"><button className="button primary" disabled={busy} onClick={()=>onChoose('signin')}>{tr('使用通行密钥登录')}</button><button className="button subtle" disabled={busy} onClick={()=>onChoose('create')}>{tr('创建新账户')}</button></div>
    {busy && <p role="status">{tr('请完成设备上的通行密钥验证…')}</p>}
    {error && <p className="document-warning" role="alert">{tr(error)}</p>}
    <details><summary>{tr('换设备与账户恢复')}</summary><p>{tr('在支持同一通行密钥的设备上选择登录，可恢复相同账户。请使用已同步的通行密钥；创建另一把密钥会生成不同账户。')}</p><a href="https://mera.category.xyz/authenticator-support/" target="_blank" rel="noreferrer">{tr('查看设备支持情况')}</a></details>
    <p className="taker-explanation">{tr('当前为测试环境。测试币请自行从官方水龙头领取，平台不发放或代领。')}</p>
    <button className="text-button" disabled={busy} onClick={onClose}>{tr('暂不登录')}</button>
  </dialog>;
}
