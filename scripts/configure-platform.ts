import { readFile, writeFile } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
const config = JSON.parse(await readFile('.runtime/platform/config.json', 'utf8'));
const keys = JSON.parse(await readFile('.runtime/platform/accounts.private.json', 'utf8')) as Record<string, Hex>;
const publicConfig = { chainId: 10143, manager: config.manager, factory: config.factory, token: config.token, deploymentBlock: config.deploymentBlock, operator: privateKeyToAccount(keys.operator!).address, worker: privateKeyToAccount(keys.worker!).address, sponsor: privateKeyToAccount(keys.sponsor!).address, rpcUrl: 'https://testnet-rpc.monad.xyz', storageUrl: config.storageUrl };
// Keep signer keys out of wrangler config, build assets, logs and public manifests.
await writeFile('.runtime/platform/cloudflare-secrets.json', JSON.stringify({ PLATFORM_CONFIG: JSON.stringify(publicConfig), PLATFORM_OPERATOR_KEY: keys.operator, PLATFORM_WORKER_KEY: keys.worker, PLATFORM_SPONSOR_KEY: keys.sponsor }), { mode: 0o600 });
await writeFile('docs/stages/R2/platform-config.json', JSON.stringify(publicConfig, null, 2) + '\n');
console.log('Prepared private Cloudflare secret file and public platform config. Keys were not printed.');
