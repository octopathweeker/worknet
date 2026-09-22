import { readFileSync } from 'node:fs';
import { isAddress, type Address } from 'viem';

export interface RuntimeConfig {
  chainId: number; rpcUrl: string; manager: Address; vault: Address; token: Address;
  deploymentBlock: string; storageUrl: string; finality: 'latest' | 'finalized';
  mode: 'local-demo' | 'testnet'; sourceHosts: string[]; judgeUrls?: string[];
}
export function loadConfig(filename: string): RuntimeConfig {
  const data = JSON.parse(readFileSync(filename, 'utf8')) as RuntimeConfig;
  if (!Number.isSafeInteger(data.chainId) || data.chainId <= 0 || !['local-demo', 'testnet'].includes(data.mode)) throw new Error('Invalid chain config');
  for (const name of ['manager', 'vault', 'token'] as const) if (!isAddress(data[name], { strict: false })) throw new Error(`Invalid ${name}`);
  for (const value of [data.rpcUrl, data.storageUrl]) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) throw new Error('Config URL cannot contain inline credentials/query');
    if (url.protocol !== 'https:' && !(data.mode === 'local-demo' && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('HTTPS required outside local demo');
  }
  if (!/^(0|[1-9][0-9]*)$/.test(data.deploymentBlock) || !Array.isArray(data.sourceHosts)) throw new Error('Invalid runtime config');
  if (data.judgeUrls !== undefined) {
    if (!Array.isArray(data.judgeUrls) || data.judgeUrls.length === 0 || data.judgeUrls.some(url => typeof url !== 'string')) throw new Error('Invalid judgeUrls');
    for (const value of data.judgeUrls) {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid judge URL');
      // Judge services may run as local loopback processes even against testnet.
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('HTTPS required outside local loopback');
    }
  }
  if (data.mode === 'local-demo' && data.chainId !== 31337) throw new Error('Local demo requires chainId 31337');
  if (data.mode === 'testnet' && (data.chainId !== 10143 || data.finality !== 'finalized')) throw new Error('Testnet must use Monad Testnet and finalized reads');
  return data;
}
