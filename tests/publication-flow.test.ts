import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionData, type Address } from 'viem';
import { requesterVaultAbi } from '@agent-task/contracts';
import { confirmPublication, expiredBudgetPermission, type PublicationAccount } from '../apps/explorer/src/publication-flow.js';

const now = 1900000000;
const vault = `0x${'11'.repeat(20)}` as Address;
const operator = `0x${'22'.repeat(20)}` as Address;
const ready: PublicationAccount = { chainTimestamp: String(now), budget: { active: true, effectiveActive: true, paused: false, validAfter: '0', validUntil: String(now + 86400), vaultBalance: '500000', maxPerTask: '200000', newCommitmentCapacity: '500000' } };
const expired: PublicationAccount = { ...ready, budget: { ...ready.budget!, effectiveActive: false, validUntil: String(now - 1), newCommitmentCapacity: '0' } };
function prepared(until: number) {
  return { vault, validUntil: now - 600, calls: [{ target: vault, callData: encodeFunctionData({ abi: requesterVaultAbi, functionName: 'authorizeAgent', args: [operator, { validAfter: 0n, validUntil: BigInt(until), maxPerTask: 200000n, maxTotalCommitment: 500000n }] }) }] };
}

test('retirement uses the actual contract deadline, never the shorter signature deadline or browser clock', () => {
  assert.equal(expiredBudgetPermission(prepared(now - 1), String(now)), true);
  assert.equal(expiredBudgetPermission(prepared(now), String(now)), true);
  assert.equal(expiredBudgetPermission(prepared(now + 86400), String(now)), false, 'expired sponsor plan does not expire a wallet call');
  assert.equal(expiredBudgetPermission({ ...prepared(now - 1), calls: [] }, String(now)), false);
  assert.equal(expiredBudgetPermission({ ...prepared(now - 1), vault: operator }, String(now)), false);
  assert.equal(expiredBudgetPermission(prepared(now - 1), 'unknown'), false);
});

test('wallet success waits for chain readiness before publishing exactly once', async () => {
  let reads = 0, preparations = 0, publishes = 0, waits = 0;
  await confirmPublication({ reward: '50000', recover: async () => false, assertCurrent() {},
    readAccount: async () => ++reads < 4 ? expired : ready,
    preparePayment: async () => { preparations++; },
    publish: async () => { assert.equal(reads, 4); publishes++; }, wait: async () => { waits++; },
  });
  assert.deepEqual({ preparations, publishes, waits }, { preparations: 1, publishes: 1, waits: 2 });
});

test('a completed or in-flight publication is recovered before any funding check or new wallet operation', async () => {
  await confirmPublication({ reward: '50000', recover: async () => true, assertCurrent() {},
    readAccount: async () => { throw new Error('The original task may already hold all funds'); },
    preparePayment: async () => { assert.fail('Must not reauthorize a funded task'); },
    publish: async () => { assert.fail('Must not duplicate the original publication'); }, wait: async () => {},
  });
});

test('wallet success without effective on-chain permission cannot enqueue a task', async () => {
  let publishes = 0;
  await assert.rejects(confirmPublication({ reward: '50000', recover: async () => false, assertCurrent() {},
    readAccount: async () => expired, preparePayment: async () => {}, publish: async () => { publishes++; }, wait: async () => {},
  }), /尚未同步到链上/);
  assert.equal(publishes, 0);
});

test('wallet rejection and account switching preserve the goal without enqueueing a task', async () => {
  for (const scenario of ['rejection', 'account-switch']) {
    let switched = false;
    await assert.rejects(confirmPublication({ reward: '50000', recover: async () => false,
      assertCurrent() { if (switched) throw new Error('account-switch'); }, readAccount: async () => expired,
      preparePayment: async () => { if (scenario === 'rejection') throw new Error('rejection'); switched = true; },
      publish: async () => { assert.fail('Must not publish after cancellation'); }, wait: async () => {},
    }), new RegExp(scenario));
  }
});

test('insufficient balance does not request new payment permission', async () => {
  await assert.rejects(confirmPublication({ reward: '50000', recover: async () => false, assertCurrent() {},
    readAccount: async () => ({ ...ready, budget: { ...ready.budget!, vaultBalance: '49999' } }),
    preparePayment: async () => { assert.fail('Insufficient deposit'); }, publish: async () => { assert.fail('Insufficient deposit'); }, wait: async () => {},
  }), /余额不足/);
});
