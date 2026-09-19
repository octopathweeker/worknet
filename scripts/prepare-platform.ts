import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { encodeDeployData, encodeFunctionData, erc20Abi, parseEther, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { client, TEST_USDC, checkTestnet } from './testnet-common.js';
import { JournalWallet, privateJson, persistPrivate } from './platform-chain.js';

const storageUrl = process.env.STORAGE_URL;
if (process.argv.includes('--broadcast') && (!storageUrl || !storageUrl.startsWith('https://'))) throw new Error('Set STORAGE_URL to your HTTPS Worker origin before broadcasting.');
await checkTestnet();
const keys = await privateJson('accounts.private.json', () => Object.fromEntries(['alice', 'bob', 'taker', 'operator', 'worker', 'sponsor'].map(name => [name, generatePrivateKey()])) as Record<string, Hex>);
const addresses = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, privateKeyToAccount(key).address]));
await persistPrivate('addresses.public.json', addresses);
const oldKey = async (role: string, name: string) => {
  const text = await readFile(`.runtime/testnet-accounts/${role}.env`, 'utf8'); const match = new RegExp(`^${name}=(.+)$`, 'm').exec(text); if (!match) throw new Error(`MISSING_${name}`); return match[1]!.trim().replace(/^['"]|['"]$/g, '') as Hex;
};
const deployer = new JournalWallet(await oldKey('deployer', 'DEPLOYER_PRIVATE_KEY'), 'deployer');
const owner = new JournalWallet(await oldKey('owner', 'AGENT_PRIVATE_KEY'), 'funding-owner');
const record = await privateJson<{ manager?: Address; factory?: Address; deploymentBlock?: string }>('deployment.json', () => ({}));
async function deploy(name: 'TaskManager' | 'RequesterVaultFactory', args: unknown[], field: 'manager' | 'factory') {
  if (record[field]) return record[field]!;
  const artifact = JSON.parse(await readFile(`contracts/out/${name}.sol/${name}.json`, 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
  const receipt = await deployer.send(`deploy-${name}`, { data });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('DEPLOY_FAILED');
  record[field] = receipt.contractAddress; if (field === 'manager') record.deploymentBlock = receipt.blockNumber.toString(); await persistPrivate('deployment.json', record); return receipt.contractAddress;
}
if (!process.argv.includes('--broadcast')) {
  console.log({ mode: 'preflight', addresses, gasPrice: String(await client.getGasPrice()), deployerBalance: String(await client.getBalance({ address: deployer.account.address })), fundingOwnerBalance: String(await client.getBalance({ address: owner.account.address })), record });
} else {
  const manager = await deploy('TaskManager', [TEST_USDC], 'manager');
  const factory = await deploy('RequesterVaultFactory', [manager, TEST_USDC], 'factory');
  for (const name of ['sponsor', 'operator', 'worker']) {
    const receipt = await deployer.send(`gas-${name}-v1`, { to: addresses[name]!, value: parseEther(name === 'sponsor' ? '1.0' : '0.35') }); if (receipt.status !== 'success') throw new Error('FUNDING_FAILED');
  }
  for (const name of ['alice', 'bob']) {
    const receipt = await owner.send(`usdc-${name}-v1`, { to: TEST_USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [addresses[name]!, 1000000n] }) }); if (receipt.status !== 'success') throw new Error('FUNDING_FAILED');
  }
  const config = { chainId: 10143, manager, factory, token: TEST_USDC, deploymentBlock: record.deploymentBlock, addresses, storageUrl };
  await persistPrivate('config.json', config);
  await mkdir('docs/stages/R2', { recursive: true }); await writeFile('docs/stages/R2/deployment.json', JSON.stringify(config, null, 2) + '\n');
}
