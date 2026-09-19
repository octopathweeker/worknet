import { readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { createWalletClient, http, parseEther, formatEther, keccak256, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { checkTestnet, client, chain, rpcUrl } from './testnet-common.js';

if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error('Load the dedicated deployer environment');
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex);
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
const manifest = JSON.parse(await readFile('.runtime/testnet-accounts/addresses.public.json', 'utf8')) as { chainId: number; addresses: Record<string, Address> };
if (manifest.chainId !== 10143 || manifest.addresses.deployer !== account.address) throw new Error('Deployer does not match dedicated test accounts');
await checkTestnet();
const acceptanceTopUp = process.argv.includes('--acceptance-top-up');
const faultRetest = process.argv.includes('--fault-retest');
const workspaceTopUp = process.argv.includes('--workspace-top-up');
const targets = workspaceTopUp ? { owner: '0', requester: '0.4', transferWorker: '0', researchWorker: '0' } : faultRetest ? { owner: '0', requester: '0.7', transferWorker: '0.4', researchWorker: '0.5' } : acceptanceTopUp
  ? { owner: '0', requester: '0.9', transferWorker: '0.4', researchWorker: '0.5' }
  : { owner: '0.5', requester: '1', transferWorker: '0.5', researchWorker: '0.5' };
const plans = await Promise.all(Object.entries(targets).map(async ([role, desired]) => {
  const to = manifest.addresses[role]!; const balance = await client.getBalance({ address: to }); const target = parseEther(desired);
  return { role, to, value: balance < target ? target - balance : 0n };
}));
const balance = await client.getBalance({ address: account.address }); const gasPrice = await client.getGasPrice();
const value = plans.reduce((n, plan) => n + plan.value, 0n);
// Retain at least 1 test MON for contract deployment; actual deployment still estimates gas.
if (balance < value + gasPrice * 30000n * BigInt(plans.length) + parseEther(workspaceTopUp ? '0.1' : faultRetest ? '0.2' : acceptanceTopUp ? '0.5' : '1')) throw new Error('Insufficient test MON after preserving deployment reserve');
console.log(JSON.stringify({ chainId: 10143, deployer: account.address, deployerBalance: formatEther(balance), transfers: plans.map(p => ({ role: p.role, to: p.to, testMON: formatEther(p.value) })), broadcast: process.argv.includes('--broadcast') }, null, 2));
if (process.argv.includes('--broadcast')) {
  const suffix = workspaceTopUp ? '-workspace' : faultRetest ? '-fault-retest' : acceptanceTopUp ? '-acceptance' : '';
  const filename = `.runtime/testnet-accounts/gas-journal${suffix}.private.json`; const lockPath = filename + '.lock';
  const lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid));
  type Record = { hash: Hex; raw: Hex; to: Address; value: string; confirmed?: boolean };
  let records: { chainId: number; deployer: Address; entries: { [role: string]: Record } };
  try {
    try { records = JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; records = { chainId: 10143, deployer: account.address, entries: {} }; }
    if (records.chainId !== 10143 || records.deployer !== account.address) throw new Error('Gas journal mismatch');
    const persist = async () => { await writeFile(filename + '.tmp', JSON.stringify(records, null, 2) + '\n', { mode: 0o600 }); await rename(filename + '.tmp', filename); };
    for (const plan of plans) {
      let record = records.entries[plan.role];
      if (!record && plan.value === 0n) continue;
      if (!record) {
        const request = await wallet.prepareTransactionRequest({ to: plan.to, value: plan.value });
        const raw = await wallet.signTransaction(request); record = { raw, hash: keccak256(raw), to: plan.to, value: plan.value.toString() };
        records.entries[plan.role] = record; await persist();
      }
      if (record.to !== plan.to) throw new Error('Gas recipient changed since journal creation');
      let receipt = await client.getTransactionReceipt({ hash: record.hash }).catch(() => undefined);
      if (!receipt) { try { await client.sendRawTransaction({ serializedTransaction: record.raw }); } catch {} receipt = await client.waitForTransactionReceipt({ hash: record.hash, timeout: 60000 }); }
      if (receipt.status !== 'success') throw new Error('Gas transfer reverted');
      const limit = Date.now() + 60000;
      while ((await client.getBlock({ blockTag: 'finalized' })).number < receipt.blockNumber) { if (Date.now() > limit) throw new Error('Finality timeout'); await new Promise(r => setTimeout(r, 1000)); }
      if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Receipt block mismatch');
      record.confirmed = true; await persist(); console.log(JSON.stringify({ role: plan.role, transactionHash: record.hash, status: receipt.status }));
    }
    await writeFile(`docs/stages/${workspaceTopUp ? 'R1' : 'M5'}/gas-distribution${suffix}.json`, JSON.stringify({ chainId: 10143, deployer: account.address, transfers: Object.entries(records.entries).map(([role, r]) => ({ role, to: r.to, amountWei: r.value, hash: r.hash, confirmed: r.confirmed })) }, null, 2) + '\n');
  } finally { await lock.close(); await unlink(lockPath); }
}
