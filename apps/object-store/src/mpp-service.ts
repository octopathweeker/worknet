import { Mppx } from 'mppx/server';
import { Credential, Store } from 'mppx';
import { monad } from '@monad-crypto/mpp/server';
import { agentRefSchema, verifyWorkerBinding } from '@agent-task/identity';
import { formatUnits, recoverMessageAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { canonicalJson, hashJson } from '@agent-task/protocol/json';
import type { Env } from './index.js';
import { platformBody, platformClient, platformConfig, platformRate } from './platform-api.js';
import { recomputeTransfers } from './platform-execution.js';
import { toolRequestSchema } from './tool-payments.js';
import { orderProofMessage } from './mpp-policy.js';

export const toolServiceConfigSchema = z.object({
  agent: agentRefSchema, recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  priceBaseUnits: z.string().regex(/^[1-9][0-9]{0,8}$/),
  origin: z.string().url().refine(value => { const u = new URL(value); return u.protocol === 'https:' && u.origin === value; }),
}).strict();
type Order = { id: string; input_hash: string; credential_hash: string; tx_hash: string; receipt: string; response: string | null };

/** Public push-mode MPP service. Durable order ownership complements SDK verification. */
export async function mppService(request: Request, env: Env): Promise<Response> {
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  if (!env.DB || !env.MPP_SERVICE_CONFIG || !env.MPP_SERVICE_SECRET || env.MPP_SERVICE_SECRET.length < 32) return reply({ error: 'SERVICE_NOT_CONFIGURED' }, 503);
  try {
    const config = platformConfig(env), service = toolServiceConfigSchema.parse(JSON.parse(env.MPP_SERVICE_CONFIG));
    const url = new URL(request.url);
    if (url.origin !== service.origin) return reply({ error: 'ORIGIN_MISMATCH' }, 400);
    if (request.method === 'GET' && url.pathname === '/services/agent.json') {
      return reply({ type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'Worknet Transfer Analysis', description: 'USDC Transfer statistics with finalized block provenance. MPP monad/charge, push mode. Testnet assets.', image: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#182624"/><text x="32" y="43" text-anchor="middle" font-size="36" fill="#bcebd5">W</text></svg>'), active: true, worknetPaymentProof: { version: 'worknet-mpp-order/1', header: 'x-worknet-payment-proof', signing: 'EIP-191' }, services: [{ name: 'web', endpoint: service.origin }, { name: 'MPP', endpoint: `${service.origin}/services/transfers`, version: '1' }], registrations: [{ agentId: service.agent.agentId, agentRegistry: `eip155:${service.agent.chainId}:${service.agent.registry}` }] });
    }
    if (request.method !== 'POST' || url.pathname !== '/services/transfers' || url.search) return reply({ error: 'NOT_FOUND' }, 404);
    await platformRate(env, `mpp-service:${request.headers.get('cf-connecting-ip') ?? 'local'}`, 60);
    const id = z.string().regex(/^0x[0-9a-f]{64}$/).parse(request.headers.get('idempotency-key'));
    const input = toolRequestSchema.shape.input.parse(await platformBody(request));
    if (input.token.toLowerCase() !== config.token.toLowerCase() || BigInt(input.fromBlock) > BigInt(input.toBlock) || BigInt(input.toBlock) - BigInt(input.fromBlock) > 1000n) return reply({ error: 'INPUT_INVALID' }, 400);
    const inputHash = hashJson(input), auth = request.headers.get('authorization');
    if (auth) {
      const credential = Credential.deserialize<{type:string;hash?:Hex}>(auth);
      const proof = request.headers.get('x-worknet-payment-proof');
      const payer = /^did:pkh:eip155:10143:(0x[0-9a-fA-F]{40})$/.exec(credential.source??'')?.[1];
      if (!payer || credential.payload.type!=='hash' || !/^0x[0-9a-fA-F]{64}$/.test(credential.payload.hash??'') || !/^0x[0-9a-fA-F]{130}$/.test(proof??'')) return reply({error:'ORDER_PROOF_REQUIRED'},403);
      const signer=await recoverMessageAddress({message:orderProofMessage(url.href,id,inputHash,credential.payload.hash!,config.token),signature:proof as Hex});
      if (!isAddressEqual(signer,payer as Address)) return reply({error:'ORDER_PROOF_INVALID'},403);
    }
    let order = await env.DB.prepare('SELECT * FROM tool_service_orders WHERE id=?').bind(id).first<Order>();
    if (order) {
      if (!auth || order.input_hash !== inputHash || order.credential_hash !== hashJson(auth)) return reply({ error: 'ORDER_CONFLICT' }, 409);
    } else {
      const client = platformClient(config);
      if (service.agent.chainId !== '10143') throw new Error('SERVICE_CHAIN_MISMATCH');
      const identity = await verifyWorkerBinding(client, service.agent, service.recipient as Address, [service.agent.registry]);
      if (identity.agentURI !== `${service.origin}/services/agent.json`) throw new Error('SERVICE_IDENTITY_URI_MISMATCH');
      // Pull credentials are deliberately rejected: no unrestricted provider gas signer is exposed.
      if (auth && (Credential.deserialize(auth).payload as any)?.type !== 'hash') return reply({ error: 'PUSH_PAYMENT_REQUIRED' }, 400);
      const mpp = Mppx.create({ methods: [monad({ currency: config.token, recipient: service.recipient, amount: formatUnits(BigInt(service.priceBaseUnits), 6), decimals: 6, testnet: true, getClient: () => client, store: Store.memory() })], secretKey: env.MPP_SERVICE_SECRET, realm: url.host });
      const payment = await mpp.charge!({ expires: new Date(Date.now() + 10 * 60000), scope: `${url.pathname}:${id}:${inputHash}` })(new Request(request.url, { method: request.method, headers: request.headers, body: canonicalJson(input) }));
      if (payment.status === 402) return payment.challenge;
      const credential = Credential.deserialize<{ type: 'hash'; hash: Hex }>(auth!);
      // Official SDK validates the receipt. This atomic UNIQUE hash claim survives concurrency,
      // restart, and loss between payment verification and response generation.
      const receiptHeader = payment.withReceipt(new Response()).headers.get('payment-receipt')!;
      await env.DB.prepare('INSERT OR IGNORE INTO tool_service_orders(id,input_hash,credential_hash,tx_hash,receipt,created_at) VALUES (?,?,?,?,?,?)').bind(id, inputHash, hashJson(auth), credential.payload.hash.toLowerCase(), receiptHeader, Date.now()).run();
      order = await env.DB.prepare('SELECT * FROM tool_service_orders WHERE id=?').bind(id).first<Order>();
      if (!order || order.credential_hash !== hashJson(auth) || order.input_hash !== inputHash) return reply({ error: 'PAYMENT_ALREADY_USED' }, 409);
    }
    if (!order.response) {
      // No execution context is passed: this is the underlying computation, never a recursive purchase.
      const result = await recomputeTransfers(input, config);
      await env.DB.prepare('UPDATE tool_service_orders SET response=? WHERE id=? AND response IS NULL').bind(canonicalJson(result), id).run();
      order = (await env.DB.prepare('SELECT * FROM tool_service_orders WHERE id=?').bind(id).first<Order>())!;
    }
    return new Response(order.response, { headers: { 'content-type': 'application/json', 'payment-receipt': order.receipt, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  } catch { return reply({ error: 'SERVICE_UNAVAILABLE' }, 503); }
}
