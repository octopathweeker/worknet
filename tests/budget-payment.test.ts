import assert from 'node:assert/strict';
import { test } from 'node:test';
import { walletPaymentComplete, paymentMethod } from '../apps/explorer/src/budget-payment.js';

test('recharge recovery requires all transaction receipts; partial deposits and RPC uncertainty never count as complete', async () => {
  const journal = { mode: 'sequential', steps: [{ hash: '0x01' }, { hash: '0x02' }, { hash: '0x03' }, { hash: '0x04' }] };
  assert.equal(await walletPaymentComplete(journal, 4, async hash => hash === '0x04' ? undefined : { status: 'success' }), false);
  assert.equal(await walletPaymentComplete(journal, 4, async hash => ({ status: hash === '0x04' ? 'reverted' : 'success' })), false);
  assert.equal(await walletPaymentComplete(journal, 4, async () => ({ status: 'success' })), true);
  assert.equal(await walletPaymentComplete({ ...journal, steps: journal.steps.slice(0, 3) }, 4, async () => ({ status: 'success' })), false);
  assert.equal(await walletPaymentComplete({ mode: 'batch', batchId: 'unknown' }, 4, async () => ({ status: 'success' })), false);
});

test('recharge never switches a started payment route and duplicates its deposit', () => {
  assert.equal(paymentMethod(true, false, false, false, true), 'sponsor');
  assert.equal(paymentMethod(false, true, false, false, true), 'sponsor');
  assert.equal(paymentMethod(false, false, true, true), 'wallet');
  assert.equal(paymentMethod(false, false, false, true), 'sponsor');
  assert.equal(paymentMethod(false, false, false, false), 'wallet');
  assert.equal(paymentMethod(false, false, false, true, true), 'wallet');
});
