import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import ipaddr from 'ipaddr.js';
import { boundedBody } from './storage.js';

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  return parsed.range() === 'unicast';
}
export function allowedSource(value: string, hosts: string[]): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || url.hash || !hosts.includes(url.hostname)) throw new Error('SOURCE_URL_NOT_ALLOWED');
  return url;
}
/** Pin the checked DNS address into this request; redirects re-enter the same checks. */
export async function fetchPublicText(value: string, hosts: string[], signal: AbortSignal, redirects = 0): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await fetchPublicTextOnce(value, hosts, signal, redirects, attempt); }
    catch (error) {
      const failure = error as { code?: string; message?: string };
      const transient = failure.message === 'SOURCE_TIMEOUT' || /^SOURCE_HTTP_5[0-9]{2}$/.test(failure.message ?? '') || ['ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(failure.code ?? '');
      if (attempt > 0 || signal.aborted || !transient) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw new Error('SOURCE_UNAVAILABLE');
}
async function fetchPublicTextOnce(value: string, hosts: string[], signal: AbortSignal, redirects: number, attempt: number): Promise<string> {
  const url = allowedSource(value, hosts);
  let addresses = await lookup(url.hostname, { all: true });
  // Explicit opt-in for local VPNs using fake-IP DNS. Still connect only to checked public IPs.
  if (addresses.some(item => !isPublicAddress(item.address)) && process.env.RESEARCH_DOH === 'true') {
    const resolver = new URL('https://cloudflare-dns.com/dns-query');
    resolver.searchParams.set('name', url.hostname); resolver.searchParams.set('type', 'A');
    const response = await fetch(resolver, { headers: { accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    if (!response.ok) throw new Error('PUBLIC_DNS_UNAVAILABLE');
    const answer = await response.json() as { Status: number; Answer?: Array<{ type: number; data: string }> };
    if (answer.Status !== 0) throw new Error('PUBLIC_DNS_UNAVAILABLE');
    addresses = (answer.Answer ?? []).filter(a => a.type === 1).map(a => ({ address: a.data, family: 4 }));
  }
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('SOURCE_ADDRESS_NOT_PUBLIC');
  addresses.sort((a, b) => a.address.localeCompare(b.address));
  const first = addresses[attempt % addresses.length]!;
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'GET', headers: { 'user-agent': 'AgentTaskNetwork/0.1 research', accept: 'text/plain,text/markdown,text/html' }, signal,
      lookup: (_hostname, options, callback) => options.all ? callback(null, [first]) : callback(null, first.address, first.family),
    }, async response => {
      try {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 3) throw new Error('SOURCE_REDIRECT_LIMIT');
          resolve(await fetchPublicText(new URL(response.headers.location, url).href, hosts, signal, redirects + 1)); return;
        }
        if (response.statusCode !== 200) { response.resume(); throw new Error(`SOURCE_HTTP_${response.statusCode}`); }
        const contentType = response.headers['content-type'] ?? '';
        if (!/^text\//.test(contentType) && !contentType.includes('json')) { response.resume(); throw new Error('SOURCE_CONTENT_TYPE'); }
        const bytes = await boundedBody(response, 256 * 1024);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        resolve(contentType.includes('html') ? text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : text);
      } catch (error) { response.destroy(); reject(error); }
    });
    request.setTimeout(15000, () => request.destroy(new Error('SOURCE_TIMEOUT')));
    request.once('error', reject); request.end();
  });
}
