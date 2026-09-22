import type { DurableObjectState } from '@cloudflare/workers-types';
import { createWalletClient, encodeFunctionData, erc20Abi, http, isAddressEqual, keccak256, parseEventLogs, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import { resolveAgent, verifyWorkerBinding, type IdentitySnapshot } from '@agent-task/identity';
import { canonicalJson, hashJson } from '@agent-task/protocol/json';
import { taskManagerAbi } from '@agent-task/contracts';
import { z } from 'zod';
import type { Challenge } from 'mppx';
import type { Env } from './index.js';
import { platformBody, platformClient, platformConfig } from './platform-api.js';
import { transferOutput } from './platform-domain.js';
import { boundedToolJson, paymentCredential, toolPaymentConfigSchema, validateToolChallenge, verifyPaymentReceipt, verifyProviderEndpoint, orderProofMessage, type ToolPaymentConfig } from './mpp-policy.js';

const integer = z.string().regex(/^(0|[1-9][0-9]{0,76})$/);
export const toolRequestSchema = z.object({
  owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(s => s.toLowerCase()), taskId: integer, attempt: integer, runId: z.string().uuid().optional(), executorId: z.string().uuid().optional(),
  specHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  input: z.object({ sourceChainId: z.literal('10143'), token: z.string().regex(/^0x[0-9a-fA-F]{40}$/), fromBlock: integer, toBlock: integer }).strict(),
}).strict().refine(value => !value.executorId || !!value.runId, 'Executor requires a run');
export type ToolRequest = z.infer<typeof toolRequestSchema>;
type Intent = { id: Hex; fingerprint: Hex; request: ToolRequest; endpoint: string; payer: Address; token: Address; amount: string; identity: IdentitySnapshot; challenge: Challenge.Challenge; raw?: Hex; hash?: Hex; confirmed?: boolean; failed?: boolean; gasWei?: string; result?: ToolResult };
export type ToolResult = { output: { eventCount: string; totalAmountBaseUnits: string }; provenance: { sourceChainId: string; blockRange: { fromBlock: string; toBlock: string; toBlockHash: Hex }; toolVersion: string }; artifact: { uri: string; hash: Hex; mediaType: string; sizeBytes: number } };

export async function reserveToolPayment(env: Env, id: string, request: ToolRequest, amount: string, policy: ToolPaymentConfig, payer: string, identity: IdentitySnapshot) {
  const existing = await env.DB!.prepare('SELECT id,amount,payer FROM platform_tool_payments WHERE id=?').bind(id).first<{id:string;amount:number;payer:string}>();
  if (existing) { if (existing.amount !== Number(amount) || existing.payer !== payer) throw new Error('MPP_RESERVATION_CONFLICT'); return; }
  const day = new Date().toISOString().slice(0, 10);
  // SQLite evaluates limits and inserts in a single statement, across actor restarts.
  const row = await env.DB!.prepare(`INSERT OR IGNORE INTO platform_tool_payments(id,owner,task_id,attempt,day,amount,payer,status,provider,created_at)
    SELECT ?,?,?,?,?,?,?,'reserved',?,? WHERE
    (SELECT COALESCE(SUM(amount),0) FROM platform_tool_payments WHERE task_id=?) + ? <= ? AND
    (SELECT COALESCE(SUM(amount),0) FROM platform_tool_payments WHERE day=?) + ? <= ? AND
    (SELECT count(*) FROM platform_tool_payments WHERE day=?) < 100 RETURNING id`)
    .bind(id, request.owner, request.taskId, request.attempt, day, Number(amount), payer, canonicalJson(identity), Date.now(), request.taskId, Number(amount), Number(policy.maxPerTask), day, Number(amount), Number(policy.maxPerDay), day).first();
  if (!row) throw new Error('MPP_BUDGET_LIMIT');
}

/** One named actor per platform payer. No caller can select another actor or destination. */
export class ToolPayments {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}
  async fetch(request: Request): Promise<Response> {
    const operation = this.tail.then(async () => {
      try {
        if (request.method !== 'POST' || new URL(request.url).pathname !== '/purchase') return new Response('Not found', { status: 404 });
        const input = toolRequestSchema.parse(await platformBody(request));
        return Response.json(await this.purchase(input));
      } catch (error) {
        const known = /\b(?:MPP_[A-Z_]+|IDENTITY_[A-Z_]+)\b/.exec(String(error))?.[0] ?? 'MPP_UNAVAILABLE';
        return Response.json({ error: known }, { status: 503 });
      }
    });
    this.tail = operation.catch(() => undefined); return operation;
  }
  private async active(input: ToolRequest) {
    const config = platformConfig(this.env), client = platformClient(config);
    const [task, block, row] = await Promise.all([
      client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getTask', args: [BigInt(input.taskId)], blockTag: 'finalized' }),
      client.getBlock({ blockTag: 'finalized' }),
      this.env.DB!.prepare("SELECT owner,body FROM platform_goals WHERE json_extract(body,'$.taskId')=?").bind(input.taskId).first<{ owner: string; body: string }>(),
    ]);
    const goal = row ? JSON.parse(row.body) : null;
    if (!goal?.spec || task.status !== 1 || task.attempt.toString() !== input.attempt || task.specHash !== input.specHash || hashJson(goal.spec) !== input.specHash || hashJson(goal.spec.input) !== hashJson(input.input) || goal.spec.capability !== 'analysis.token-transfers' || task.claimLeaseExpiresAt <= block.timestamp + 20n) throw new Error('MPP_TASK_INACTIVE');
    if (input.runId) {
      const run = await this.env.DB!.prepare('SELECT body,executor_id,result_hash FROM platform_runs WHERE id=? AND owner=? AND task_id=? AND attempt=? AND revoked=0').bind(input.runId, input.owner, input.taskId, input.attempt).first<{ body: string; executor_id: string|null; result_hash: string|null }>();
      const grant = run ? JSON.parse(run.body) : null;
      if (!grant?.authorized || run?.result_hash || grant.specHash !== input.specHash || BigInt(grant.validUntil) <= block.timestamp || task.worker.toLowerCase() !== input.owner) throw new Error('MPP_TASK_INACTIVE');
      if (input.executorId) {
        if (run!.executor_id !== input.executorId || grant.hostedAgent) throw new Error('MPP_EXECUTOR_INACTIVE');
        const executor = await this.env.DB!.prepare('SELECT id FROM platform_executors WHERE id=? AND owner=? AND approved=1 AND revoked=0 AND expires_at>?').bind(input.executorId,input.owner,Date.now()).first();
        if (!executor) throw new Error('MPP_EXECUTOR_INACTIVE');
      } else {
        const job = await this.env.DB!.prepare('SELECT id FROM platform_hosted_jobs WHERE id=? AND owner=? AND active=1 AND cancelled=0').bind(input.runId,input.owner).first();
        if (run!.executor_id || grant.hostedAgent !== 'transfers-v1' || !job) throw new Error('MPP_TASK_INACTIVE');
      }
    } else if (row!.owner !== input.owner || goal.input.execution === 'market' || !isAddressEqual(task.worker, config.worker)) throw new Error('MPP_TASK_INACTIVE');
    return { config, client };
  }
  private async persist(intent: Intent) { await this.ctx.storage.put(`payment:${intent.id}`, intent); }
  private async reconcilePending() {
    const pending = await this.ctx.storage.get<string>('pending-payment'); if (!pending) return;
    const previous = await this.ctx.storage.get<Intent>(`payment:${pending}`); if (!previous?.hash) throw new Error('MPP_OUTBOX_INVALID');
    const client = platformClient(platformConfig(this.env));
    const receipt = await client.getTransactionReceipt({hash:previous.hash}).catch(()=>undefined);
    if (!receipt || (await client.getBlock({blockTag:'finalized'})).number < receipt.blockNumber || (await client.getBlock({blockNumber:receipt.blockNumber})).hash !== receipt.blockHash) return;
    previous.gasWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
    if (receipt.status === 'success') {
      const logs = parseEventLogs({abi:erc20Abi,eventName:'Transfer',logs:receipt.logs});
      if (!logs.some(log=>isAddressEqual(log.address,previous.token)&&isAddressEqual(log.args.from,previous.payer)&&isAddressEqual(log.args.to,previous.identity.agentWallet)&&log.args.value===BigInt(previous.amount))) throw new Error('MPP_TRANSFER_MISMATCH');
      previous.confirmed = true;
    } else previous.failed = true;
    await this.persist(previous);
    await this.env.DB!.prepare('UPDATE platform_tool_payments SET status=?,tx_hash=?,gas_wei=? WHERE id=?').bind(previous.confirmed?'paid':'reverted',previous.hash,previous.gasWei,pending).run();
    await this.ctx.storage.delete('pending-payment');
  }
  private async purchase(input: ToolRequest): Promise<ToolResult> {
    if (!this.env.MPP_TOOL_CONFIG || !this.env.MPP_PAYER_KEY || !this.env.DB) throw new Error('MPP_NOT_CONFIGURED');
    const policy = toolPaymentConfigSchema.parse(JSON.parse(this.env.MPP_TOOL_CONFIG));
    await this.reconcilePending();
    const { config, client } = await this.active(input);
    const account = privateKeyToAccount(this.env.MPP_PAYER_KEY as Hex);
    if ([config.worker, config.operator, config.sponsor].some(a => isAddressEqual(a, account.address))) throw new Error('MPP_DEDICATED_PAYER_REQUIRED');
    const id = hashJson({ manager: config.manager.toLowerCase(), taskId: input.taskId, attempt: input.attempt, tool: 'analysis.token-transfers' });
    const fingerprint = hashJson(input);
    let intent = await this.ctx.storage.get<Intent>(`payment:${id}`);
    if (intent && (intent.fingerprint !== fingerprint || intent.payer !== account.address)) throw new Error('MPP_INTENT_CONFLICT');
    if (intent?.result) {
      await this.env.DB.prepare("UPDATE platform_tool_payments SET status='delivered',tx_hash=?,gas_wei=?,evidence_hash=? WHERE id=?").bind(intent.hash,intent.gasWei,intent.result.artifact.hash,id).run();
      return intent.result;
    }
    if (intent?.failed) throw new Error('MPP_PAYMENT_REVERTED');
    // Do not allocate another nonce while an earlier signed payment is uncertain.
    const pending = await this.ctx.storage.get<string>('pending-payment');
    if (pending && pending !== id) throw new Error('MPP_PREVIOUS_PAYMENT_PENDING');
    if (!intent) {
      if (policy.provider.chainId !== '10143') throw new Error('MPP_CHAIN_MISMATCH');
      const identity = await resolveAgent(client, policy.provider, [policy.provider.registry]);
      if (isAddressEqual(identity.agentWallet,account.address)) throw new Error('MPP_SELF_PAYMENT_NOT_ALLOWED');
      await verifyProviderEndpoint(identity,policy.endpoint);
      const response = await fetch(policy.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': id }, body: canonicalJson(input.input), redirect: 'manual', signal: AbortSignal.timeout(15000) });
      const challenge = validateToolChallenge(response, policy, identity, config.token); await response.body?.cancel();
      const amount = challenge.request.amount as string;
      await reserveToolPayment(this.env, id, input, amount, policy, account.address, identity);
      intent = { id, fingerprint, request: input, endpoint: policy.endpoint, payer: account.address, token: config.token, amount, identity, challenge };
      await this.persist(intent);
    }
    if (!intent.raw) {
      await this.active(input);
      intent.identity = await verifyWorkerBinding(client, intent.identity.ref, intent.identity.agentWallet, [policy.provider.registry]);
      await verifyProviderEndpoint(intent.identity,intent.endpoint);
      if (await client.readContract({address:intent.token,abi:erc20Abi,functionName:'decimals'}) !== 6) throw new Error('MPP_TOKEN_DECIMALS_MISMATCH');
      if (Date.parse(intent.challenge.expires!) <= Date.now() + 20000) throw new Error('MPP_EXPIRED');
      const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(config.rpcUrl, { timeout: 15000, retryCount: 0 }) });
      const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [intent.identity.agentWallet, BigInt(intent.amount)] });
      const gas = (await client.estimateGas({ account, to: intent.token, data })) * 120n / 100n;
      const prepared = await wallet.prepareTransactionRequest({ to: intent.token, data, value: 0n, gas, nonce: await client.getTransactionCount({ address: account.address, blockTag: 'pending' }) });
      const maximumGas = gas * (prepared.maxFeePerGas ?? prepared.gasPrice ?? 0n);
      if (maximumGas <= 0n || maximumGas > BigInt(policy.maxGasWei)) throw new Error('MPP_GAS_LIMIT');
      await this.active(input);
      intent.raw = await wallet.signTransaction(prepared); intent.hash = keccak256(intent.raw);
      await this.ctx.storage.put({ [`payment:${id}`]: intent, 'pending-payment': id });
    }
    if (!intent.confirmed) {
      let receipt = await client.getTransactionReceipt({ hash: intent.hash! }).catch(() => undefined);
      if (!receipt) {
        await this.active(input);
        try { await client.sendRawTransaction({ serializedTransaction: intent.raw }); } catch { /* Only a matching mined receipt settles the outbox. */ }
        receipt = await client.waitForTransactionReceipt({ hash: intent.hash!, timeout: 18000 });
      }
      const final = await client.getBlock({ blockTag: 'finalized' });
      if (final.number < receipt.blockNumber) throw new Error('MPP_AWAITING_FINALITY');
      const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (canonical.hash !== receipt.blockHash) throw new Error('MPP_AWAITING_FINALITY');
      intent.gasWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
      if (receipt.status !== 'success') { intent.failed = true; await this.persist(intent); await this.ctx.storage.delete('pending-payment'); await this.env.DB.prepare("UPDATE platform_tool_payments SET status='reverted',tx_hash=?,gas_wei=? WHERE id=?").bind(intent.hash, intent.gasWei, id).run(); throw new Error('MPP_PAYMENT_REVERTED'); }
      const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs });
      if (!transfers.some(log => isAddressEqual(log.address, intent!.token) && isAddressEqual(log.args.from, account.address) && isAddressEqual(log.args.to, intent!.identity.agentWallet) && log.args.value === BigInt(intent!.amount))) throw new Error('MPP_TRANSFER_MISMATCH');
      intent.confirmed = true; await this.persist(intent); await this.ctx.storage.delete('pending-payment');
      await this.env.DB.prepare("UPDATE platform_tool_payments SET status='paid',tx_hash=?,gas_wei=? WHERE id=?").bind(intent.hash, intent.gasWei, id).run();
    }
    // Persisted hash/challenge are reused, even if the provider lost a response. Never auto-pay a second 402.
    const proof = await account.signMessage({message:orderProofMessage(intent.endpoint,id,hashJson(input.input),intent.hash!,intent.token)});
    const response = await fetch(intent.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': id, authorization: paymentCredential(intent.challenge, intent.hash!, account.address), 'x-worknet-payment-proof':proof }, body: canonicalJson(input.input), redirect: 'manual', signal: AbortSignal.timeout(20000) });
    verifyPaymentReceipt(response, intent.hash!);
    const value = z.object({ output: transferOutput, provenance: z.object({ sourceChainId: z.literal('10143'), blockRange: z.object({ fromBlock: integer, toBlock: integer, toBlockHash: z.string().regex(/^0x[0-9a-f]{64}$/) }).strict(), toolVersion: z.string().min(1).max(200) }).strict() }).strict().parse(await boundedToolJson(response));
    if (value.provenance.blockRange.fromBlock !== input.input.fromBlock || value.provenance.blockRange.toBlock !== input.input.toBlock) throw new Error('MPP_RESULT_BINDING_MISMATCH');
    const evidence = { schema: 'worknet-tool-purchase/1', taskManager: config.manager.toLowerCase(), taskId: input.taskId, attempt: input.attempt, specHash: input.specHash, provider: intent.identity, endpoint: intent.endpoint, requestHash: hashJson(input.input), responseHash: hashJson(value), payer: account.address, amountBaseUnits: intent.amount, token: intent.token, chainId: '10143', paymentTransaction: intent.hash!, gasWei: intent.gasWei!, payerRole: 'platform', method: 'monad', intent: 'charge' };
    const hash = hashJson(evidence), body = canonicalJson(evidence);
    await this.env.DB.prepare('INSERT OR IGNORE INTO objects(hash,body,created_at) VALUES (?,?,?)').bind(hash, body, Date.now()).run();
    intent.result = { ...value, provenance: { ...value.provenance, blockRange: { ...value.provenance.blockRange, toBlockHash: value.provenance.blockRange.toBlockHash as Hex } }, artifact: { uri: `${config.storageUrl}/objects/${hash}`, hash, mediaType: 'application/vnd.worknet.tool-purchase+json', sizeBytes: new TextEncoder().encode(body).byteLength } };
    await this.persist(intent);
    await this.env.DB.prepare("UPDATE platform_tool_payments SET status='delivered',tx_hash=?,gas_wei=?,evidence_hash=? WHERE id=?").bind(intent.hash,intent.gasWei,hash,id).run();
    return intent.result;
  }
}

export async function purchaseTransferTool(env: Env, input: ToolRequest): Promise<ToolResult> {
  if (!env.TOOL_PAYMENTS) throw new Error('MPP_NOT_CONFIGURED');
  const actor = env.TOOL_PAYMENTS.get(env.TOOL_PAYMENTS.idFromName('platform-tools-v1'));
  const response = await actor.fetch('https://internal/purchase', { method: 'POST', headers: { 'content-type': 'application/json' }, body: canonicalJson(input) });
  const value = await response.json() as any;
  if (!response.ok) throw new Error(value.error ?? 'MPP_UNAVAILABLE');
  return value as ToolResult;
}

export async function taskToolPayments(env: Env, taskId: string, attempt: string) {
  const row = await env.DB!.prepare("SELECT json_group_array(json_object('status',status,'amountBaseUnits',CAST(amount AS TEXT),'payer',payer,'gasWei',gas_wei,'transactionHash',tx_hash,'evidenceHash',evidence_hash)) items FROM platform_tool_payments WHERE task_id=? AND attempt=?").bind(taskId, attempt).first<{ items: string }>();
  return JSON.parse(row?.items ?? '[]') as unknown[];
}

/** Attach only server-owned purchase evidence matching this exact execution. */
export async function externalToolArtifacts(env: Env, owner: string, taskId: string, attempt: string, specHash: string, execution: unknown) {
  const row = await env.DB!.prepare("SELECT evidence_hash FROM platform_tool_payments WHERE owner=? AND task_id=? AND attempt=? AND status='delivered'").bind(owner,taskId,attempt).first<{evidence_hash:string}>();
  if (!row) return [];
  const stored = await env.DB!.prepare('SELECT body FROM objects WHERE hash=?').bind(row.evidence_hash).first<{body:string}>();
  if (!stored) throw new Error('MPP_EVIDENCE_UNAVAILABLE');
  const evidence = JSON.parse(stored.body);
  if (hashJson(evidence) !== row.evidence_hash || evidence.taskId !== taskId || evidence.attempt !== attempt || evidence.specHash !== specHash || evidence.responseHash !== hashJson(execution)) throw new Error('MPP_RESULT_MISMATCH');
  return [{uri:`${platformConfig(env).storageUrl}/objects/${row.evidence_hash}`,hash:row.evidence_hash,mediaType:'application/vnd.worknet.tool-purchase+json',sizeBytes:new TextEncoder().encode(stored.body).byteLength}];
}
