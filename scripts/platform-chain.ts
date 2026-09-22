import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createWalletClient, keccak256, http, type Hex, type Address, type SignedAuthorization } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, client, rpcUrl } from './testnet-common.js';

export const platformDirectory = '.runtime/platform';
export async function privateJson<T>(name: string, create: () => T, directory = platformDirectory): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { return JSON.parse(await readFile(`${directory}/${name}`, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const value = create(); await persistPrivate(name, value, directory); return value; }
}
export async function persistPrivate(name: string, value: unknown, directory = platformDirectory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = `${directory}/${name}`;
  await writeFile(file + '.tmp', JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n', { mode: 0o600 }); await rename(file + '.tmp', file);
}
type Entry = { fingerprint: Hex; raw: Hex; hash: Hex; status?: string; contractAddress?: Address | null };
/** Dedicated test signers only. Persist raw bytes before broadcast; retry identical bytes. */
export class JournalWallet {
  readonly account; readonly wallet;
  constructor(key: Hex, readonly name: string, readonly directory = platformDirectory) { this.account = privateKeyToAccount(key); this.wallet = createWalletClient({ account: this.account, chain, transport: http(rpcUrl) }); }
  async send(id: string, call: { to?: Address; data?: Hex; value?: bigint; authorizationList?: SignedAuthorization[]; gas?: bigint }) {
    const entries = await privateJson<Record<string, Entry>>(`journal-${this.name}.json`, () => ({}), this.directory);
    const fingerprint = keccak256(new TextEncoder().encode(JSON.stringify(call, (_, v) => typeof v === 'bigint' ? v.toString() : v)));
    let entry = entries[id];
    if (entry && entry.fingerprint !== fingerprint) throw new Error(`INTENT_CONFLICT: ${id}`);
    if (!entry) {
      if (Object.values(entries).some(x => !x.status)) throw new Error('RESOLVE_PENDING_JOURNAL_FIRST');
      const gas = call.gas ?? await client.estimateGas({ ...call, account: this.account });
      const request = await this.wallet.prepareTransactionRequest({ ...call, gas: gas * 120n / 100n, nonce: await client.getTransactionCount({ address: this.account.address, blockTag: 'pending' }) });
      const raw = await this.wallet.signTransaction(request); entry = { raw, hash: keccak256(raw), fingerprint }; entries[id] = entry;
      await persistPrivate(`journal-${this.name}.json`, entries, this.directory);
    }
    let receipt = await client.getTransactionReceipt({ hash: entry.hash }).catch(() => undefined);
    if (!receipt) { try { await client.sendRawTransaction({ serializedTransaction: entry.raw }); } catch { /* only receipt confirms */ } receipt = await client.waitForTransactionReceipt({ hash: entry.hash, timeout: 60000 }); }
    for (let i = 0; (await client.getBlock({ blockTag: 'finalized' })).number < receipt.blockNumber; i++) { if (i > 40) throw new Error('FINALITY_TIMEOUT'); await new Promise(r => setTimeout(r, 750)); }
    entry.status = receipt.status; entry.contractAddress = receipt.contractAddress ?? null; await persistPrivate(`journal-${this.name}.json`, entries, this.directory);
    console.log(JSON.stringify({ step: id, hash: receipt.transactionHash, status: receipt.status, gasUsed: receipt.gasUsed.toString() }));
    return receipt;
  }
}
