import {t as tr,locale} from './i18n';
import React, { useEffect, useRef } from 'react';
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    plus: <path d="M12 5v14M5 12h14"/>, arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>, chevron: <path d="m9 5 7 7-7 7"/>, down: <path d="m6 9 6 6 6-6"/>, check: <path d="m5 12 4 4L19 6"/>, close: <path d="m6 6 12 12M6 18 18 6"/>,
    goal: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="m14 10 6-6"/></>,
    file: <><path d="M7 3h7l4 4v14H7zM14 3v5h4M10 12h5m-5 4h5"/></>,
    worker: <><rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8"/></>,
    settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,
    grid: <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>,
    clock: <><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></>,
    link: <><path d="m9 15 6-6m-7 4-2 2a3 3 0 0 0 4 4l3-3m-2-5 3-3a3 3 0 0 1 4 4l-2 2"/></>,
    spark: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>,
    pause: <path d="M8 5v14M16 5v14"/>, play: <path d="m8 5 11 7-11 7z"/>,
    wallet: <><path d="M4 6h15v14H4zM4 6V4h12v2"/><path d="M15 11h5v4h-5z"/></>,
    warning: <><path d="m12 3 10 18H2zM12 9v5m0 3h.01"/></>,
    logout: <><path d="M10 4H4v16h6M8 12h12m-4-4 4 4-4 4"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.file}</svg>;
}
export function Brand() { return <span className="brand"><svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M4 7h6l5 17H9zM15 7h6l-5 17h-6zM21 7h7l-5 17h-7z" fill="currentColor"/></svg><span>worknet</span></span>; }
export function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const before = document.activeElement as HTMLElement | null; ref.current?.showModal(); (ref.current?.querySelector('input,textarea') as HTMLElement | null)?.focus(); return () => { ref.current?.close(); before?.focus(); }; }, []);
  return <dialog ref={ref} className="dialog" aria-labelledby="dialog-heading" onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) onClose(); }}><div className="dialog-inner"><button type="button" className="icon-button dialog-close" onClick={onClose} aria-label={tr("关闭")}><Icon name="close"/></button><h2 id="dialog-heading">{title}</h2>{children}</div></dialog>;
}
export function Money({ amount = '0' }: { amount?: string }) { return <>{formatMoney(amount)}</>; }
export function formatMoney(amount = '0') { try { const n = BigInt(amount); return `${(n / 1000000n).toLocaleString(locale())}.${((n % 1000000n) / 10000n).toString().padStart(2, '0')}`; } catch { return '—'; } }
export function relative(date: string) { const mins = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 60000)); return tr(mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : mins < 1440 ? `${Math.floor(mins / 60)} 小时前` : new Date(date).toLocaleDateString(locale())); }
export function short(address = '') { return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '—'; }
