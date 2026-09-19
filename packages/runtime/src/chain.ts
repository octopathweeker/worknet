import { randomUUID } from 'node:crypto';
import { createPublicClient, createWalletClient, defineChain, http, encodeFunctionData, encodeFunctionResult, decodeFunctionResult, keccak256, decodeEventLog, erc20Abi, type Abi, type Address, type Hex, type PublicClient, type Transport, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { taskManagerAbi } from '@agent-task/contracts';
import type { RuntimeConfig } from './config.js';
import { State, json } from './state.js';

export function chainClient(config: RuntimeConfig): PublicClient<Transport, Chain> {
  const chain = defineChain({ id: config.chainId, name: config.mode === 'local-demo' ? 'Local Monad Demo' : 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
  return createPublicClient({ chain, cacheTime: 0, pollingInterval: config.mode === 'local-demo' ? 100 : 1000, transport: http(config.rpcUrl, { timeout: 10000, retryCount: 2 }) });
}
export type ChainClient = ReturnType<typeof chainClient>;
export async function checkChain(config: RuntimeConfig, client: ChainClient = chainClient(config)): Promise<void> {
  if (await client.getChainId() !== config.chainId) throw new Error('CHAIN_ID_MISMATCH');
  for (const address of [config.manager, config.vault, config.token]) if (!await client.getCode({ address })) throw new Error(`NO_CONTRACT: ${address}`);
  const token = await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'settlementToken' });
  if (token.toLowerCase() !== config.token.toLowerCase()) throw new Error('SETTLEMENT_TOKEN_MISMATCH');
  if (await client.readContract({ address: config.token, abi: erc20Abi, functionName: 'decimals' }) !== 6) throw new Error('TOKEN_DECIMALS_MISMATCH');
}
export function getTask(client: ChainClient, config: RuntimeConfig, id: bigint) {
  return client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getTask', args: [id], blockTag: config.finality });
}
export type OnchainTask = Awaited<ReturnType<typeof getTask>>;

/** Terminal task fields never change. Preserve ABI types rather than JSON-coercing bigints. */
export async function getCachedTask(client: ChainClient, config: RuntimeConfig, state: State, id: bigint): Promise<OnchainTask> {
  const key = `terminal-task:${config.chainId}:${config.manager.toLowerCase()}:${id}`;
  const encoded = state.get<Hex>(key);
  if (encoded) return decodeFunctionResult({ abi: taskManagerAbi, functionName: 'getTask', data: encoded });
  const task = await getTask(client, config, id);
  if (task.status >= 3) state.set(key, encodeFunctionResult({ abi: taskManagerAbi, functionName: 'getTask', result: task }));
  return task;
}

/** Durable raw transaction outbox. A logical retry rebroadcasts the exact same signed bytes. */
export class Signer {
  readonly account; readonly client: ChainClient; private readonly wallet;
  private tail: Promise<unknown> = Promise.resolve(); private readonly scope: string; private readonly owner = `${process.pid}:${randomUUID()}`;
  constructor(readonly config: RuntimeConfig, private readonly state: State, privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey); this.client = chainClient(config);
    this.wallet = createWalletClient({ account: this.account, chain: this.client.chain, transport: http(config.rpcUrl, { timeout: 10000, retryCount: 0 }) });
    this.scope = `${config.chainId}:${this.account.address.toLowerCase()}`;
    state.transaction(() => {
      const row = state.db.prepare('SELECT owner FROM leases WHERE name=?').get(this.scope);
      if (row) {
        try { process.kill(Number(String(row.owner).split(':')[0]), 0); throw new Error('SIGNER_ALREADY_RUNNING'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      state.db.prepare('INSERT OR REPLACE INTO leases VALUES (?,?)').run(this.scope, this.owner);
    });
  }
  async write(address: Address, abi: Abi, functionName: string, args: readonly unknown[], intent: string = randomUUID()): Promise<Hex> {
    const work = this.tail.then(() => this.send(address, abi, functionName, args, intent));
    this.tail = work.catch(() => undefined); return work;
  }
  private async confirm(row: { id: string; raw: Hex; hash: Hex }): Promise<Hex> {
    try { await this.client.sendRawTransaction({ serializedTransaction: row.raw }); }
    catch (broadcastError) {
      // Already known/mined is safe only when this exact hash can be recovered.
      try { await this.client.getTransaction({ hash: row.hash }); } catch { throw broadcastError; }
    }
    const receipt = await this.client.waitForTransactionReceipt({ hash: row.hash, timeout: 60000, pollingInterval: 500 });
    if (receipt.status !== 'success') {
      this.state.db.prepare("UPDATE transactions SET status='reverted' WHERE id=?").run(row.id);
      throw new Error(`TRANSACTION_REVERTED: ${row.hash}`);
    }
    if (this.config.finality === 'finalized') {
      const limit = Date.now() + 60000;
      while ((await this.client.getBlock({ blockTag: 'finalized' })).number < receipt.blockNumber) {
        if (Date.now() > limit) throw new Error('FINALITY_TIMEOUT');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    this.state.db.prepare("UPDATE transactions SET status='confirmed' WHERE id=?").run(row.id);
    return row.hash;
  }
  private async send(address: Address, abi: Abi, functionName: string, args: readonly unknown[], intent: string): Promise<Hex> {
    const id = `${this.scope}:${address.toLowerCase()}:${intent}`;
    const data = encodeFunctionData({ abi, functionName, args }); const fingerprint = `${address.toLowerCase()}:${data}`;
    const existing = this.state.db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('TRANSACTION_INTENT_CONFLICT');
      if (existing.status === 'reverted') throw new Error(`TRANSACTION_PREVIOUSLY_REVERTED: ${existing.hash}`);
      if (existing.status === 'confirmed') return String(existing.hash) as Hex;
      return this.confirm({ id, raw: String(existing.raw) as Hex, hash: String(existing.hash) as Hex });
    }
    for (const pending of this.state.db.prepare("SELECT * FROM transactions WHERE status='signed' AND substr(id,1,?)=? ORDER BY rowid").all(this.scope.length + 1, `${this.scope}:`)) {
      await this.confirm({ id: String(pending.id), raw: String(pending.raw) as Hex, hash: String(pending.hash) as Hex });
    }
    await this.client.call({ account: this.account.address, to: address, data });
    const gas = await retryTransientRead(() => this.client.estimateGas({ account: this.account.address, to: address, data }));
    const nonce = await this.client.getTransactionCount({ address: this.account.address, blockTag: 'pending' });
    const prepared = await this.wallet.prepareTransactionRequest({ to: address, data, nonce, gas: gas * 120n / 100n });
    const raw = await this.wallet.signTransaction(prepared); const hash = keccak256(raw);
    this.state.db.prepare('INSERT INTO transactions VALUES (?,?,?,?,?)').run(id, fingerprint, raw, hash, 'signed');
    return this.confirm({ id, raw, hash });
  }
  async close(): Promise<void> { await this.tail; this.state.db.prepare('DELETE FROM leases WHERE name=? AND owner=?').run(this.scope, this.owner); }
}

/** Retry only transient RPC failures; never replace estimation with a guessed gas limit. */
export async function retryTransientRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error) {
      let cause: unknown = error; let transient = false;
      for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
        const value = cause as { code?: number; status?: number; cause?: unknown };
        if (value.code === -32603 || value.code === -32005 || value.status === 429 || value.status === 503) transient = true;
        cause = value.cause;
      }
      if (!transient || attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
}

export async function scanTasks(client: ChainClient, config: RuntimeConfig, state: State): Promise<bigint[]> {
  const scope = `${config.chainId}:${config.manager.toLowerCase()}`;
  const head = await client.getBlock({ blockTag: config.finality });
  const cursor = state.get<{ next: string; blockHash: Hex }>(`cursor:${scope}`);
  let from = cursor ? BigInt(cursor.next) : BigInt(config.deploymentBlock);
  if (cursor && from > BigInt(config.deploymentBlock)) {
    if ((await client.getBlock({ blockNumber: from - 1n })).hash !== cursor.blockHash) throw new Error('CHAIN_HISTORY_CHANGED');
  }
  while (from <= head.number) {
    const span = config.mode === 'testnet' ? 99n : 999n;
    const to = from + span < head.number ? from + span : head.number;
    const logs = await client.getLogs({ address: config.manager, fromBlock: from, toBlock: to });
    const blockHash = (await client.getBlock({ blockNumber: to })).hash;
    state.transaction(() => {
      for (const log of logs) {
        const decoded = decodeEventLog({ abi: taskManagerAbi, data: log.data, topics: log.topics });
        const id = `${scope}:${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
        state.db.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?)').run(id, log.blockNumber.toString(), json({ ...decoded, transactionHash: log.transactionHash, blockNumber: log.blockNumber }));
        if ('taskId' in decoded.args) state.set(`known:${scope}:${decoded.args.taskId}`, decoded.args.taskId.toString());
      }
      state.set(`cursor:${scope}`, { next: (to + 1n).toString(), blockHash });
    });
    from = to + 1n;
  }
  return state.list<string>(`known:${scope}:`).map(item => BigInt(item.value)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
