import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskBudgetIssue, publicationBudgetIssue, renewalAmount, type TaskBudget } from '../apps/explorer/src/budget-status.js';

const now = 1900000000;
const funded: TaskBudget = { active: true, paused: false, effectiveActive: true, validAfter: '0', validUntil: String(now + 86400), vaultBalance: '500000', maxPerTask: '200000', newCommitmentCapacity: '500000' };

test('funded task distinguishes expired and exhausted authorization from insufficient funds', () => {
  assert.equal(taskBudgetIssue(funded, '50000', now), undefined);
  assert.match(taskBudgetIssue({ ...funded, effectiveActive: false, validUntil: String(now), newCommitmentCapacity: '0' }, '50000', now)!, /授权已过期.*无需充值/);
  assert.match(taskBudgetIssue({ ...funded, active: false, effectiveActive: false }, '50000', now)!, /未启用或已撤销/);
  assert.match(taskBudgetIssue({ ...funded, newCommitmentCapacity: '49999' }, '50000', now)!, /剩余付款授权额度不足/);
  assert.match(taskBudgetIssue({ ...funded, vaultBalance: '49999' }, '50000', now)!, /余额不足/);
  assert.match(taskBudgetIssue({ ...funded, maxPerTask: '49999' }, '50000', now)!, /单笔授权上限/);
  assert.match(taskBudgetIssue({ ...funded, paused: true }, '50000', now)!, /暂停/);
  assert.match(taskBudgetIssue({ ...funded, validAfter: String(now + 1) }, '50000', now)!, /尚未生效/);
});

test('authorization must outlast both execution and review, including the exact contract boundary', () => {
  assert.match(taskBudgetIssue({ ...funded, validUntil: String(now + 4200) }, '50000', now)!, /覆盖任务与审核/);
  assert.equal(taskBudgetIssue({ ...funded, validUntil: String(now + 4201) }, '50000', now), undefined);
  assert.match(taskBudgetIssue(undefined, '50000', now)!, /同步/);
  assert.match(taskBudgetIssue(null, '50000', now)!, /尚未准备/);
});

test('renewal is limited to existing balance and the supported total allowance', () => {
  assert.equal(renewalAmount(undefined), undefined);
  assert.equal(renewalAmount('9999'), undefined);
  assert.equal(renewalAmount('10000'), '10000');
  assert.equal(renewalAmount('500000'), '500000');
  assert.equal(renewalAmount('7000000'), '5000000');
});

test('publishing stays available with funded expired or exhausted permission, but never with missing funds', () => {
  assert.equal(publicationBudgetIssue({ ...funded, effectiveActive: false, validUntil: String(now - 1), newCommitmentCapacity: '0' }, '50000'), undefined);
  assert.equal(publicationBudgetIssue({ ...funded, active: false, newCommitmentCapacity: '0' }, '50000'), undefined);
  assert.equal(publicationBudgetIssue({ ...funded, maxPerTask: '10000', newCommitmentCapacity: '0' }, '50000'), undefined);
  assert.match(publicationBudgetIssue({ ...funded, vaultBalance: '49999' }, '50000')!, /余额不足/);
  assert.match(publicationBudgetIssue({ ...funded, paused: true }, '50000')!, /暂停/);
  assert.match(publicationBudgetIssue(undefined, '50000')!, /同步/);
  assert.match(publicationBudgetIssue(null, '50000')!, /余额不足/);
});
