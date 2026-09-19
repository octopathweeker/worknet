import { createPublicClient, defineChain, http, erc20Abi, type Address } from 'viem';

export const TEST_USDC: Address = '0x534b2f3A21130d7a60830c2Df862319e593943A3';
export const rpcUrl = process.env.MONAD_RPC_URL ?? 'https://testnet-rpc.monad.xyz';
const url = new URL(rpcUrl);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('MONAD_RPC_URL must be HTTPS without inline credentials or query');
export const chain = defineChain({ id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
export const client = createPublicClient({ chain, cacheTime: 0, pollingInterval: 1000, transport: http(rpcUrl, { timeout: 15000, retryCount: 1 }) });
export async function checkTestnet() {
  if (await client.getChainId() !== 10143) throw new Error('Expected Monad Testnet chain 10143; refusing other networks');
  const code = await client.getCode({ address: TEST_USDC });
  if (!code || code === '0x') throw new Error('Circle test USDC is not deployed at the expected address');
  const decimals = await client.readContract({ address: TEST_USDC, abi: erc20Abi, functionName: 'decimals' });
  if (decimals !== 6) throw new Error('Unexpected USDC decimals');
  const block = await client.getBlock({ blockTag: 'finalized' });
  return { chainId: 10143, token: TEST_USDC, decimals, finalizedBlock: block.number.toString(), finalizedHash: block.hash, finalizedTimestamp: block.timestamp.toString() };
}
