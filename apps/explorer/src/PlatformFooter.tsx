import React from 'react';
import { t as tr } from './i18n';

const providers = [
  ['Monad', 'https://monad.xyz/'],
  ['Mera', 'https://mera.category.xyz/'],
  ['TypeSafe', 'https://typesafe.ai/'],
  ['OpenRouter', 'https://openrouter.ai/'],
  ['Cloudflare', 'https://www.cloudflare.com/'],
] as const;
export function PlatformFooter() {
  return <footer className="workspace-footer platform-footer">
    <p>{tr('任务描述与链上记录公开；启用私有交付后，报告以密文保存。')}</p>
    <div><span>© {new Date().getFullYear()} Worknet · Monad Testnet</span><nav aria-label={tr('技术支持')}><span>{tr('技术支持')}</span>{providers.map(([name,url])=><a key={name} href={url} target="_blank" rel="noreferrer">{name}</a>)}</nav></div>
  </footer>;
}
