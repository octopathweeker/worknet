import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { erc20Abi, formatEther, formatUnits, type Address, type Hex } from 'viem';
import { checkTestnet, client, TEST_USDC } from './testnet-common.js';

const directory = path.resolve('.runtime/testnet-accounts');
const filename = path.join(directory, 'accounts.private.json');
const roles = ['owner', 'deployer', 'requester', 'transferWorker', 'researchWorker'] as const;
type Role = typeof roles[number];
type Accounts = { version: 1; chainId: 10143; createdAt: string; accounts: Record<Role, { address: Address; privateKey: Hex }>; apiToken: string; storageToken: string };
await mkdir(directory, { recursive: true, mode: 0o700 });
let data: Accounts;
try { data = JSON.parse(await readFile(filename, 'utf8')) as Accounts; }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  if (process.argv.includes('--check')) throw new Error('Run pnpm testnet:prepare to create dedicated test-only accounts first');
  data = { version: 1, chainId: 10143, createdAt: new Date().toISOString(), accounts: Object.fromEntries(roles.map(role => {
    const privateKey = generatePrivateKey(); return [role, { address: privateKeyToAccount(privateKey).address, privateKey }];
  })) as Accounts['accounts'], apiToken: randomBytes(32).toString('hex'), storageToken: randomBytes(32).toString('hex') };
  // Exclusive creation prevents a retry from replacing an account that may already be funded.
  await writeFile(filename, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
if (data.chainId !== 10143 || data.version !== 1 || roles.some(role => privateKeyToAccount(data.accounts[role].privateKey).address !== data.accounts[role].address)) throw new Error('Test account file integrity mismatch; do not replace it');
const addresses = Object.fromEntries(roles.map(role => [role, data.accounts[role].address]));
const publicManifest = { chainId: 10143, purpose: 'Dedicated Monad Testnet accounts; not the public Anvil accounts', createdAt: data.createdAt, addresses };
await writeFile(path.join(directory, 'addresses.public.json'), JSON.stringify(publicManifest, null, 2) + '\n');
if (process.argv.includes('--check')) {
  await checkTestnet();
  const balances = await Promise.all(roles.map(async role => {
    const address = data.accounts[role].address;
    const [native, usdc] = await Promise.all([client.getBalance({ address }), client.readContract({ address: TEST_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address] })]);
    return { role, address, testMON: formatEther(native), testUSDC: formatUnits(usdc, 6), hasNativeGas: native > 0n, hasTestUSDC: usdc > 0n };
  }));
  const report = { checkedAt: new Date().toISOString(), ...publicManifest, balances, broadcast: false };
  await writeFile(path.join(directory, 'funding.public.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} else {
  const common = `MONAD_RPC_URL=https://testnet-rpc.monad.xyz\nDEMO_CONFIG=${path.resolve('.runtime/testnet/config.json')}\nSTORAGE_UPLOAD_TOKEN=${data.storageToken}\n`;
  const envs: Record<string, string> = {
    deployer: `DEPLOYER_PRIVATE_KEY=${data.accounts.deployer.privateKey}\nOWNER_ADDRESS=${data.accounts.owner.address}\nREQUESTER_ADDRESS=${data.accounts.requester.address}\nDEPLOYMENT_DIR=${path.resolve('.runtime/testnet')}\n`,
    requester: `AGENT_PRIVATE_KEY=${data.accounts.requester.privateKey}\nREQUESTER_API_TOKEN=${data.apiToken}\n`,
    transferWorker: `AGENT_PRIVATE_KEY=${data.accounts.transferWorker.privateKey}\n`,
    researchWorker: `AGENT_PRIVATE_KEY=${data.accounts.researchWorker.privateKey}\n`,
    owner: `AGENT_PRIVATE_KEY=${data.accounts.owner.privateKey}\n`,
  };
  for (const [name, values] of Object.entries(envs)) {
    try { await writeFile(path.join(directory, `${name}.env`), common + values, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  console.log(JSON.stringify({ ...publicManifest, credentialsDirectory: directory, next: 'Fund test MON for transaction accounts and test USDC for Owner. Set public HTTPS STORAGE_URL, then use explicit node --env-file for each role. No transaction was broadcast.' }, null, 2));
}
