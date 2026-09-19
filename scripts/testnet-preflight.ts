import { mkdir, writeFile } from 'node:fs/promises';
import { checkTestnet } from './testnet-common.js';

const report: Record<string, unknown> = { checkedAt: new Date().toISOString(), broadcast: false, network: 'pending' };
try { report.network = await checkTestnet(); }
catch (error) {
  // Never print transport errors containing private RPC URLs or provider keys.
  report.network = { ok: false, errorType: error instanceof Error ? error.name : 'UnknownError', message: 'RPC or chain validation failed; verify MONAD_RPC_URL privately.' };
  process.exitCode = 1;
}
const groups = {
  deployment: ['DEPLOYER_PRIVATE_KEY', 'OWNER_ADDRESS', 'REQUESTER_ADDRESS', 'STORAGE_URL'],
  runtime: ['AGENT_PRIVATE_KEY', 'STORAGE_UPLOAD_TOKEN', 'REQUESTER_API_TOKEN'],
  realModel: ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'],
};
report.configuration = Object.fromEntries(Object.entries(groups).map(([group, names]) => [group, Object.fromEntries(names.map(name => [name, Boolean(process.env[name])]))]));
report.notes = ['Configuration flags only check presence, not validity or balances.', 'No deployment, funding, wallet creation or model call is performed.', 'Workers need their own private keys, native test MON and an HTTPS storage endpoint.'];
await mkdir('.runtime', { recursive: true });
await writeFile('.runtime/testnet-preflight.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
