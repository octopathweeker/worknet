import { getAddress, isAddressEqual, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';

export const identityRegistryAbi = parseAbi([
  'function ownerOf(uint256 agentId) view returns (address)',
  'function tokenURI(uint256 agentId) view returns (string)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function register(string agentURI) returns (uint256 agentId)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
]);
export const reputationRegistryAbi = parseAbi([
  'function getIdentityRegistry() view returns (address)',
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
]);
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(s => BigInt(s) < 2n ** 256n);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => getAddress(value)).refine(a => a !== zeroAddress);
export const agentRefSchema = z.object({ chainId: uint.refine(s => BigInt(s) > 0n), registry: address, agentId: uint }).strict();
export type AgentRef = z.infer<typeof agentRefSchema>;
export type IdentitySnapshot = {
  ref: AgentRef; owner: Address; agentWallet: Address; agentURI: string;
  blockNumber: string; blockHash: Hex; registryCodeHash?: Hex;
};

/** Registry data is read at one finalized block; no arbitrary agentURI is fetched. */
export async function resolveAgent(client: PublicClient, input: AgentRef, trustedRegistries: readonly Address[]): Promise<IdentitySnapshot> {
  const ref = agentRefSchema.parse(input);
  if (!trustedRegistries.some(registry => isAddressEqual(registry, ref.registry))) throw new Error('IDENTITY_REGISTRY_NOT_TRUSTED');
  if (BigInt(await client.getChainId()) !== BigInt(ref.chainId)) throw new Error('IDENTITY_CHAIN_MISMATCH');
  const block = await client.getBlock({ blockTag: 'finalized' });
  if (block.number === null || !block.hash) throw new Error('IDENTITY_FINALITY_UNAVAILABLE');
  const at = { address: ref.registry, abi: identityRegistryAbi, blockNumber: block.number } as const;
  const [code, owner, wallet, agentURI] = await Promise.all([
    client.getCode({ address: ref.registry, blockNumber: block.number }),
    client.readContract({ ...at, functionName: 'ownerOf', args: [BigInt(ref.agentId)] }),
    client.readContract({ ...at, functionName: 'getAgentWallet', args: [BigInt(ref.agentId)] }),
    client.readContract({ ...at, functionName: 'tokenURI', args: [BigInt(ref.agentId)] }),
  ]);
  if (!code || code === '0x' || owner === zeroAddress) throw new Error('IDENTITY_NOT_REGISTERED');
  if (wallet === zeroAddress) throw new Error('IDENTITY_WALLET_UNBOUND');
  if (agentURI.length > 16384) throw new Error('IDENTITY_URI_TOO_LARGE');
  return { ref, owner: getAddress(owner), agentWallet: getAddress(wallet), agentURI, blockNumber: block.number.toString(), blockHash: block.hash };
}

export async function verifyWorkerBinding(client: PublicClient, ref: AgentRef, worker: Address, trustedRegistries: readonly Address[]) {
  const snapshot = await resolveAgent(client, ref, trustedRegistries);
  if (!isAddressEqual(snapshot.agentWallet, worker)) throw new Error('IDENTITY_WALLET_MISMATCH');
  return snapshot;
}

/** Worknet's optional reference uses canonical lowercase addresses in hashed manifests. */
export function manifestAgentRef(snapshot: IdentitySnapshot) {
  return { ...snapshot.ref, registry: snapshot.ref.registry.toLowerCase() };
}
