import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, erc20Abi, keccak256, type Abi, type Hex, type Address } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { requesterVaultAbi } from '@agent-task/contracts';

const rpcUrl = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
const parsed = new URL(rpcUrl);
if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Local deployment only permits loopback HTTP');
const chain = defineChain({ id: 31337, name: 'Local Monad Demo', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
// Public Anvil development mnemonic. Never use these accounts on a public network.
const mnemonic = 'test test test test test test test test test test test junk';
const owner = mnemonicToAccount(mnemonic, { addressIndex: 0 });
const agent = mnemonicToAccount(mnemonic, { addressIndex: 1 });
const client = createPublicClient({ chain, cacheTime: 0, pollingInterval: 100, transport: http() });
if (await client.getChainId() !== 31337) throw new Error('Refusing to deploy demo contracts outside chain 31337');
const wallet = createWalletClient({ account: owner, chain, transport: http() });
async function deploy(name: string, args: readonly unknown[] = []): Promise<Address> {
  const artifact = JSON.parse(await readFile(`contracts/out/${name}.sol/${name}.json`, 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args, gas: 15_000_000n });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`Deploy failed: ${name}`);
  return receipt.contractAddress;
}
const deploymentBlock = (await client.getBlockNumber()).toString();
const token = await deploy('MockUSDC'); const manager = await deploy('TaskManager', [token]); const vault = await deploy('RequesterVault', [owner.address, manager, token]);
const tokenArtifact = JSON.parse(await readFile('contracts/out/MockUSDC.sol/MockUSDC.json', 'utf8')) as { abi: Abi };
async function write(address: Address, abi: Abi, functionName: string, args: readonly unknown[]) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, gas: 3_000_000n });
  const receipt = await client.waitForTransactionReceipt({ hash }); if (receipt.status !== 'success') throw new Error(`Setup failed: ${functionName}`);
}
await write(token, tokenArtifact.abi, 'mint', [owner.address, 50_000_000n]);
await write(token, erc20Abi, 'approve', [vault, 50_000_000n]);
await write(vault, requesterVaultAbi, 'deposit', [50_000_000n]);
const now = (await client.getBlock()).timestamp;
await write(vault, requesterVaultAbi, 'authorizeAgent', [agent.address, { validAfter: now, validUntil: now + 86400n, maxPerTask: 2_000_000n, maxTotalCommitment: 10_000_000n }]);
// Public, clearly labelled fixture transfers for the deterministic worker.
const fromBlock = (await client.getBlockNumber()) + 1n;
await write(token, tokenArtifact.abi, 'mint', [owner.address, 3_000_000n]);
await write(token, erc20Abi, 'transfer', ['0x0000000000000000000000000000000000000011', 1_000_000n]);
await write(token, erc20Abi, 'transfer', ['0x0000000000000000000000000000000000000022', 2_000_000n]);
const toBlock = await client.getBlockNumber();
const output = process.env.DEMO_CONFIG ?? '.runtime/config.json';
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({
  mode: 'local-demo', chainId: 31337, rpcUrl, token, manager, vault,
  deploymentBlock, storageUrl: process.env.STORAGE_URL ?? 'http://127.0.0.1:8787', finality: 'latest',
  sourceHosts: ['docs.monad.xyz', 'monad.xyz', 'www.monad.xyz'],
  owner: owner.address, agent: agent.address, tokenDecimals: 6, tokenLabel: 'dUSDC · Demo token, not Circle USDC',
  fixture: { token, fromBlock: fromBlock.toString(), toBlock: toBlock.toString() },
  deployedBytecodeHash: { manager: keccak256((await client.getCode({ address: manager }))!), vault: keccak256((await client.getCode({ address: vault }))!) },
}, null, 2) + '\n');
console.log(JSON.stringify({ mode: 'local-demo', config: output, token, manager, vault }));
