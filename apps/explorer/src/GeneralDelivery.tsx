import React from 'react';
import { t as tr } from './i18n';
export function GeneralDelivery({ output }: { output: { content: string; sources?: Array<{ title: string; url: string }> } }) {
  return <div className="general-delivery"><div className="general-delivery-content">{output.content}</div>{!!output.sources?.length && <section><h3>{tr('交付来源')}</h3><ul>{output.sources.map((source, index) => {
    let href: string | undefined;
    try { const url = new URL(source.url); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) href = url.href; } catch { /* Render unsafe links as text only. */ }
    return <li key={index}>{href ? <a href={href} target="_blank" rel="noreferrer">{source.title}</a> : source.title}</li>;
  })}</ul><p>{tr('来源由执行 Agent 提供；Jev 按约定和交付证据评分，链接本身不代表事实已独立核实。')}</p></section>}</div>;
}
