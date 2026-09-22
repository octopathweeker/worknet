import { Challenge, Credential, Receipt } from 'mppx';
import { isAddressEqual, type Address, type Hex } from 'viem';
import { agentRefSchema, type IdentitySnapshot } from '@agent-task/identity';
import { z } from 'zod';

const amount = z.string().regex(/^[1-9][0-9]{0,8}$/);
export const toolPaymentConfigSchema = z.object({
  endpoint: z.string().url().max(512).refine(s => { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && !u.port && !/^(localhost|127\.|\[|0\.)/.test(u.hostname); }),
  provider: agentRefSchema,
  maxPerCall: amount, maxPerTask: amount, maxPerDay: amount,
  maxGasWei: z.string().regex(/^[1-9][0-9]{0,18}$/),
}).strict().refine(c => BigInt(c.maxPerCall) <= BigInt(c.maxPerTask) && BigInt(c.maxPerTask) <= BigInt(c.maxPerDay));
export type ToolPaymentConfig = z.infer<typeof toolPaymentConfigSchema>;
export function orderProofMessage(endpoint:string,id:string,inputHash:string,transactionHash:string,token:string) {
  return ['worknet-mpp-order/1','10143',new URL(endpoint).href,id,inputHash,transactionHash.toLowerCase(),token.toLowerCase()].join('\n');
}

export async function verifyProviderEndpoint(identity: IdentitySnapshot, endpoint: string) {
  const target = new URL(endpoint), registration = new URL(identity.agentURI);
  if (registration.protocol !== 'https:' || registration.origin !== target.origin || registration.username || registration.password || registration.hash) throw new Error('MPP_REGISTRATION_ORIGIN_MISMATCH');
  const response = await fetch(registration.href,{redirect:'manual',signal:AbortSignal.timeout(10000)});
  const card = await boundedToolJson(response) as any;
  const registry = `eip155:${identity.ref.chainId}:${identity.ref.registry}`.toLowerCase();
  if (card.type !== 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1' || card.active === false || !Array.isArray(card.services) || !card.services.some((s:any)=>s.name==='MPP'&&s.endpoint===endpoint) || !Array.isArray(card.registrations) || !card.registrations.some((r:any)=>String(r.agentId)===identity.ref.agentId&&String(r.agentRegistry).toLowerCase()===registry)) throw new Error('MPP_REGISTRATION_MISMATCH');
}

/** Inspect the wire challenge before any signing or broadcasting. Amounts are base units. */
export function validateToolChallenge(response: Response, config: ToolPaymentConfig, identity: IdentitySnapshot, token: Address, now = Date.now()) {
  if (response.status !== 402) throw new Error('MPP_CHALLENGE_REQUIRED');
  const challenge = Challenge.fromResponse(response);
  const request = challenge.request;
  if (challenge.method !== 'monad' || challenge.intent !== 'charge' || challenge.header && challenge.header.toLowerCase() !== 'authorization') throw new Error('MPP_METHOD_NOT_ALLOWED');
  if (challenge.realm !== new URL(config.endpoint).host) throw new Error('MPP_REALM_MISMATCH');
  if (identity.ref.chainId !== '10143' || (request.methodDetails as { chainId?: number } | undefined)?.chainId !== 10143) throw new Error('MPP_CHAIN_MISMATCH');
  if (typeof request.currency !== 'string' || !isAddressEqual(request.currency as Address, token)) throw new Error('MPP_CURRENCY_MISMATCH');
  if (typeof request.recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(request.recipient) || !isAddressEqual(request.recipient as Address, identity.agentWallet)) throw new Error('MPP_RECIPIENT_MISMATCH');
  if (typeof request.amount !== 'string' || !/^[1-9][0-9]{0,8}$/.test(request.amount) || BigInt(request.amount) > BigInt(config.maxPerCall)) throw new Error('MPP_PRICE_LIMIT');
  const expires = challenge.expires ? Date.parse(challenge.expires) : NaN;
  if (!Number.isFinite(expires) || expires < now + 30000 || expires > now + 15 * 60000) throw new Error('MPP_EXPIRY_INVALID');
  return challenge;
}

/** Explicit push-mode credential: the application outbox owns signing and nonce recovery. */
export function paymentCredential(challenge: Challenge.Challenge, hash: Hex, payer: Address) {
  return Credential.serialize({ challenge, payload: { type: 'hash', hash }, source: `did:pkh:eip155:10143:${payer}` });
}
export function verifyPaymentReceipt(response: Response, hash: Hex) {
  const raw = response.headers.get('payment-receipt');
  if (!raw) throw new Error('MPP_RECEIPT_MISSING');
  const receipt = Receipt.deserialize(raw);
  if (receipt.method !== 'monad' || receipt.status !== 'success' || receipt.reference.toLowerCase() !== hash.toLowerCase()) throw new Error('MPP_RECEIPT_MISMATCH');
  return receipt;
}

export async function boundedToolJson(response: Response) {
  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json') || !response.body) throw new Error('MPP_SERVICE_UNAVAILABLE');
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let size = 0, text = '';
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 64000) { await reader.cancel(); throw new Error('MPP_RESPONSE_TOO_LARGE'); } text += decoder.decode(next.value, { stream: true }); }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally { reader.releaseLock(); }
}
