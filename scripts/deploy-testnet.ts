import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createWalletClient, http, isAddress, encodeDeployData, keccak256, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { checkTestnet, chain, client, rpcUrl, TEST_USDC } from './testnet-common.js';

// No environment files are implicitly loaded; keep credentials in your shell/secret manager.
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
const owner = process.env.OWNER_ADDRESS; const agent = process.env.REQUESTER_ADDRESS;
const storageUrl = process.env.STORAGE_URL;
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('DEPLOYER_PRIVATE_KEY required');
if (!owner || !isAddress(owner) || !agent || !isAddress(agent)) throw new Error('OWNER_ADDRESS and REQUESTER_ADDRESS required');
const storage = storageUrl ? new URL(storageUrl) : undefined;
if (storage && (storage.protocol !== 'https:' || storage.username || storage.password || storage.search || storage.hash || storage.pathname !== '/')) throw new Error('STORAGE_URL must be a public HTTPS origin');
const account = privateKeyToAccount(privateKey as Hex);
const wallet = createWalletClient({ chain, account, transport: http(rpcUrl, { timeout: 15000 }) });
await checkTestnet();
const directory = path.resolve(process.env.DEPLOYMENT_DIR ?? '.runtime/testnet');
await mkdir(directory, { recursive: true, mode: 0o700 });
type Deployment = { raw: Hex; hash: Hex; dataHash: Hex; address?: Address; block?: string };
type Journal = { chainId: number; deployer: Address; owner: Address; token: Address; contracts: Record<string, Deployment> };
const journalFile = path.join(directory, 'deployment-journal.json');
let journal: Journal;
try { journal = JSON.parse(await readFile(journalFile, 'utf8')) as Journal; }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; journal = { chainId: 10143, deployer: account.address, owner, token: TEST_USDC, contracts: {} }; }
if (journal.chainId !== 10143 || journal.deployer.toLowerCase() !== account.address.toLowerCase() || journal.owner.toLowerCase() !== owner.toLowerCase() || journal.token !== TEST_USDC) throw new Error('Deployment journal belongs to another configuration');
const persist = async () => { await writeFile(`${journalFile}.tmp`, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 }); await rename(`${journalFile}.tmp`, journalFile); };
if (!process.argv.includes('--broadcast')) {
  console.log(JSON.stringify({ mode: 'plan-only', chainId: 10143, deployer: account.address, owner, agent, token: TEST_USDC, nativeBalanceWei: (await client.getBalance({ address: account.address })).toString(), completedContracts: Object.keys(journal.contracts), storageReady: Boolean(storage), next: 'Run pnpm testnet:deploy --broadcast after funding deployer. Without STORAGE_URL, only contracts and a pending config are created; runtime cannot start.' }, null, 2));
} else {
  const lockPath = path.join(directory, 'deployment.lock');
  const lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid));
  try {
    async function deploy(name: string, args: readonly unknown[]): Promise<Address> {
      const artifact = JSON.parse(await readFile(`contracts/out/${name}.sol/${name}.json`, 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
      const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
      let record = journal.contracts[name];
      if (record && record.dataHash !== keccak256(data)) throw new Error('Artifact or constructor changed since deployment journal was created');
      if (!record) {
        const gas = await client.estimateGas({ account, data });
        const request = await wallet.prepareTransactionRequest({ data, gas: gas * 120n / 100n, nonce: await client.getTransactionCount({ address: account.address, blockTag: 'pending' }) });
        const raw = await wallet.signTransaction(request);
        record = { raw, hash: keccak256(raw), dataHash: keccak256(data) };
        journal.contracts[name] = record; await persist(); // Persist before broadcasting; retries use identical bytes.
      }
      let receipt = await client.getTransactionReceipt({ hash: record.hash }).catch(() => undefined);
      if (!receipt) {
        try { await client.sendRawTransaction({ serializedTransaction: record.raw }); }
        catch { /* It may already be in the mempool; only a receipt can confirm success. */ }
        receipt = await client.waitForTransactionReceipt({ hash: record.hash, timeout: 120000 });
      }
      if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`Deployment reverted: ${name} ${record.hash}`);
      for (let i = 0; i < 90 && (await client.getBlock({ blockTag: 'finalized' })).number < receipt.blockNumber; i++) await new Promise(resolve => setTimeout(resolve, 1000));
      if ((await client.getBlock({ blockTag: 'finalized' })).number < receipt.blockNumber) throw new Error('Finality wait exceeded; rerun with the same journal');
      if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Deployment receipt block mismatch');
      record.address = receipt.contractAddress; record.block = receipt.blockNumber.toString(); await persist();
      console.log(JSON.stringify({ contract: name, address: record.address, transactionHash: record.hash }));
      return record.address;
    }
    const manager = await deploy('TaskManager', [TEST_USDC]);
    const vault = await deploy('RequesterVault', [owner, manager, TEST_USDC]);
    const config = { mode: 'testnet', chainId: 10143, rpcUrl, token: TEST_USDC, manager, vault, owner, agent,
      deploymentBlock: journal.contracts.TaskManager!.block, ...(storage ? { storageUrl: storage.origin } : {}), finality: 'finalized', sourceHosts: ['docs.monad.xyz', 'monad.xyz', 'www.monad.xyz'], tokenLabel: 'Test USDC',
      deployedBytecodeHash: { manager: keccak256((await client.getCode({ address: manager }))!), vault: keccak256((await client.getCode({ address: vault }))!) },
    };
    const configName = storage ? 'config.json' : 'config.pending.json';
    await writeFile(path.join(directory, configName), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    // Public manifest excludes private RPC URL and signed transaction journal.
    const { rpcUrl: _privateRpc, ...publicManifest } = config;
    await writeFile(path.join(directory, 'manifest.public.json'), JSON.stringify({ ...publicManifest, transactions: Object.fromEntries(Object.entries(journal.contracts).map(([name, value]) => [name, value.hash])) }, null, 2) + '\n');
    console.log(`Contracts deployed; ${path.join(directory, configName)}. ${storage ? 'Runtime configuration ready.' : 'Set public HTTPS STORAGE_URL and rerun with the same journal to finalize runtime config.'} Vault funding and authorization remain Owner actions.`);
  } finally { await lock.close(); await unlink(lockPath); }
}
