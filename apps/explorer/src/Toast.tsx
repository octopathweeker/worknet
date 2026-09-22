import React, { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './components';
import { t as tr, useLanguage } from './i18n';
import './toast.css';

type Kind = 'success' | 'error' | 'info';
type Toast = { id: number; scope: string; kind: Kind; message: string };
type ToastContextValue = { notify(scope: string, kind: Kind, message: string): void; clear(scope: string): void };
const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const notify = useCallback((scope: string, kind: Kind, message: string) => {
    if (!message.trim()) return;
    const id = ++nextId.current;
    setItems(current => {
      if (current.some(item => item.scope === scope && item.kind === kind && item.message === message)) return current;
      // A final outcome replaces the previous progress/result for this operation.
      return [...current.filter(item => item.scope !== scope), { id, scope, kind, message }].slice(-3);
    });
  }, []);
  const clear = useCallback((scope: string) => setItems(current => current.filter(item => item.scope !== scope)), []);
  const dismiss = useCallback((id: number) => setItems(current => current.filter(item => item.id !== id)), []);
  const value = useMemo(() => ({ notify, clear }), [notify, clear]);
  return <ToastContext.Provider value={value}>{children}<ToastViewport items={items} dismiss={dismiss}/></ToastContext.Provider>;
}

export function useToast() {
  const context = useContext(ToastContext);
  const scope = useId();
  if (!context) throw new Error('useToast requires ToastProvider');
  return useMemo(() => ({
    success: (message: string) => context.notify(scope, 'success', message),
    error: (message: string) => context.notify(scope, 'error', message),
    info: (message: string) => context.notify(scope, 'info', message),
    clear: () => context.clear(scope),
  }), [context, scope]);
}

function ToastViewport({ items, dismiss }: { items: Toast[]; dismiss(id: number): void }) {
  useLanguage();
  const [target, setTarget] = useState<Element>(document.body);
  useEffect(() => {
    // Native modal dialogs make body siblings inert. Put feedback inside the active
    // dialog so it stays visible, announced and keyboard-accessible in the top layer.
    const update = () => setTarget(Array.from(document.querySelectorAll('dialog[open]')).at(-1) ?? document.body);
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, []);
  const latest = items.at(-1);
  return createPortal(<section className="toast-viewport" aria-label={tr('操作提示')}>
    <div className="toast-announcer" role="status" aria-atomic="true">{latest && latest.kind !== 'error' ? tr(latest.message) : ''}</div>
    <div className="toast-announcer" role="alert" aria-atomic="true">{latest?.kind === 'error' ? tr(latest.message) : ''}</div>
    {items.map(item => <ToastCard key={item.id} item={item} dismiss={dismiss}/>)}
  </section>, target);
}

function ToastCard({ item, dismiss }: { item: Toast; dismiss(id: number): void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const remaining = useRef(item.kind === 'info' ? 8000 : 5000);
  useEffect(() => {
    const change = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    if (item.kind === 'error' || hovered || focused || hidden) return;
    const start = Date.now();
    const timer = window.setTimeout(() => dismiss(item.id), remaining.current);
    return () => { window.clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - start)); };
  }, [item.id, item.kind, hovered, focused, hidden, dismiss]);
  return <div className={`toast-card toast-${item.kind}`} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocusCapture={() => setFocused(true)} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}>
    <Icon name={item.kind === 'success' ? 'check' : item.kind === 'error' ? 'warning' : 'clock'}/>
    <div className="toast-message">{tr(item.message)}</div>
    <button type="button" className="toast-dismiss" aria-label={tr('关闭提示')} onClick={() => dismiss(item.id)}><Icon name="close" size={16}/></button>
  </div>;
}
