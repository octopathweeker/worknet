import assert from 'node:assert/strict';
import { test } from 'node:test';
import { walletPaymentComplete, walletPaymentState, paymentMethod } from '../apps/explorer/src/budget-payment.js';

test('recharge recovery requires all transaction receipts; partial deposits and RPC uncertainty never count as complete', async () => {
  const journal = { mode: 'sequential', steps: [{ hash: '0x01' }, { hash: '0x02' }, { hash: '0x03' }, { hash: '0x04' }] };
  assert.equal(await walletPaymentComplete(journal, 4, async hash => hash === '0x04' ? undefined : { status: 'success' }), false);
  assert.equal(await walletPaymentComplete(journal, 4, async hash => ({ status: hash === '0x04' ? 'reverted' : 'success' })), false);
  assert.equal(await walletPaymentComplete(journal, 4, async () => ({ status: 'success' })), true);
  assert.equal(await walletPaymentComplete({ ...journal, steps: journal.steps.slice(0, 3) }, 4, async () => ({ status: 'success' })), false);
  assert.equal(await walletPaymentComplete({ mode: 'batch', batchId: 'unknown' }, 4, async () => ({ status: 'success' })), false);
});

test('recharge never switches a started payment route and duplicates its deposit', () => {
  assert.equal(paymentMethod(true, false), 'sponsor');
  assert.equal(paymentMethod(false, true), 'sponsor');
  assert.equal(paymentMethod(true, true), 'sponsor');
  assert.equal(paymentMethod(false, false), 'wallet', 'new intents never assume raw delegation support from 7702 bytecode');
});

test('completed wallet batches clear stale sending locks by querying the original batch, without sending again', async () => {
  const queried: string[] = [];
  const batchStatus = async (id: string) => { queried.push(id); return { status: 200, chainId: '0x279f', receipts: [{ status: '0x1' }] }; };
  assert.equal(await walletPaymentComplete({ mode: 'batch', batchId: 'old-batch', sending: true }, 4, async () => undefined, batchStatus), true);
  assert.equal(await walletPaymentState({ mode: 'batch', requestId: 'lost-response', sending: true }, undefined, async () => undefined, batchStatus), 'complete');
  assert.deepEqual(queried, ['old-batch', 'lost-response']);
});

test('batch pending, failed, partially failed, unknown and wrong-chain outcomes never become successful deposits', async () => {
  const journal = { mode: 'batch', batchId: 'original', sending: false };
  const state = (status: number | string) => walletPaymentState(journal, 4, async () => undefined, async () => ({ status }));
  assert.equal(await state(100), 'pending'); assert.equal(await state('PENDING'), 'pending');
  assert.equal(await state('200'), 'complete'); assert.equal(await state('CONFIRMED'), 'complete');
  for (const code of [400, 500, 600]) assert.equal(await state(code), 'settled');
  assert.equal(await state(300), 'unknown');
  assert.equal(await walletPaymentState(journal, 4, async () => undefined, async () => { throw new Error('Wallet disconnected'); }), 'unknown');
  assert.equal(await walletPaymentState(journal, 4, async () => undefined, async () => ({ status: 200, chainId: '0x1' })), 'unknown');
  assert.equal(await walletPaymentState(journal, 4, async () => undefined, async () => ({ status: 200, receipts: [{ status: '0x0' }] })), 'settled');
});

test('sequential recovery uses receipts despite stale flags, but never clears a send without its hash', async () => {
  assert.equal(await walletPaymentState({ mode: 'sequential', steps: [{ hash: '0x01', sending: true }] }, 1, async () => ({ status: 'success' })), 'complete');
  assert.equal(await walletPaymentState({ mode: 'sequential', steps: [{ sending: true }] }, 1, async () => ({ status: 'success' })), 'unknown');
  assert.equal(await walletPaymentState({ mode: 'sequential', steps: [{ hash: '0x01' }] }, 4, async () => ({ status: 'success' })), 'settled');
  assert.equal(await walletPaymentState({ mode: 'sequential', steps: [{ hash: '0x01' }] }, 1, async () => undefined), 'pending');
  assert.equal(await walletPaymentState({ mode: 'batch', sending: true }, 4, async () => undefined), 'unknown');
});
