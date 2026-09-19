import assert from 'node:assert/strict';
import { parseTransaction, recoverTransactionAddress } from 'viem';
import { State, loadConfig, chainClient, checkChain, json } from '@agent-task/runtime';

// Recovery sends existing signed bytes only. It never substitutes calldata,
// nonce, gas or account, and never generates a new logical request.
const rpcUrl = process.env.RECOVERY_RPC_URL;
assert.ok(rpcUrl && new URL(rpcUrl).protocol === 'https:', 'Set a verified HTTPS Monad Testnet RPC');
const config = { ...loadConfig(process.env.DEMO_CONFIG ?? '.runtime/testnet/config.json'), rpcUrl };
assert.equal(config.chainId, 10143); assert.equal(config.mode, 'testnet');
const client = chainClient(config); await checkChain(config, client);
const state = new State(process.env.RECOVERY_DB ?? '.runtime/testnet/account-1.db');
try {
  for (const lease of state.db.prepare('SELECT owner FROM leases').all()) {
    let alive = false; try { process.kill(Number(String(lease.owner).split(':')[0]), 0); alive = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    assert.equal(alive, false, 'Stop the signer before outbox recovery');
  }
  for (const row of state.db.prepare("SELECT hash,raw FROM transactions WHERE status='signed' ORDER BY rowid").all()) {
    assert.match(String(row.raw), /^0x02[0-9a-f]+$/, 'Only this runtime’s signed EIP-1559 outbox is supported');
    const raw = String(row.raw) as `0x02${string}`; const tx = parseTransaction(raw); assert.equal(tx.chainId, 10143);
    const from = await recoverTransactionAddress({ serializedTransaction: raw });
    console.log(json({ hash: row.hash, from, nonce: tx.nonce, balance: await client.getBalance({ address: from }), broadcast: process.argv.includes('--broadcast') }));
    if (process.argv.includes('--broadcast')) {
      try { assert.equal(await client.sendRawTransaction({ serializedTransaction: raw }), row.hash); }
      catch (error) { if (!await client.getTransaction({ hash: String(row.hash) as `0x${string}` }).catch(() => undefined)) throw error; }
      const receipt = await client.waitForTransactionReceipt({ hash: String(row.hash) as `0x${string}`, timeout: 60000 });
      console.log(json({ hash: receipt.transactionHash, status: receipt.status, blockNumber: receipt.blockNumber }));
      // Let the owning Signer enforce finalized status and reconcile the journal.
    }
  }
} finally { state.close(); }
