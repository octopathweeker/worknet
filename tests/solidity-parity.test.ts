import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createVM } from '@ethereumjs/vm';
import { decodeFunctionResult, encodeFunctionData, hexToBytes, bytesToHex, stringToHex, type Abi, type Hex } from 'viem';
import { afterReleaseOrReject, canReview, canSubmit, hashCreateParams, leaseExpiry, parseTaskSpec, toCreateTaskParams } from '../packages/protocol/src/index.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const artifact = fixture('protocol-harness.json') as { abi: Abi; deployedBytecode: Hex };
const vectors = fixture('vectors.json');
const vm = await createVM();
async function call(functionName: string, args: unknown[]) {
  const data = encodeFunctionData({ abi: artifact.abi, functionName, args });
  const executed = await vm.evm.runCode({ code: hexToBytes(artifact.deployedBytecode), data: hexToBytes(data), gasLimit: 5_000_000n });
  assert.equal(executed.exceptionError, undefined, executed.exceptionError?.error);
  return decodeFunctionResult({ abi: artifact.abi, functionName, data: bytesToHex(executed.returnValue) });
}

test('Solidity EVM executes the frozen task, capability and parameter hash vectors', async () => {
  const spec = parseTaskSpec(readFileSync(new URL('./fixtures/task-spec.json', import.meta.url), 'utf8'));
  const params = toCreateTaskParams(spec, vectors.specURI);
  assert.equal(await call('hashBytes', [stringToHex(vectors.taskCanonical)]), vectors.specHash);
  assert.equal(await call('hashBytes', [stringToHex(vectors.resultCanonical)]), vectors.resultHash);
  assert.equal(await call('capabilityId', [spec.capability, spec.capabilityVersion]), vectors.capabilityId);
  assert.equal(await call('hashCreateParams', [vectors.operator, params]), vectors.paramsHash);
  assert.equal(await call('hashCreateParams', [vectors.operator, { ...params, rewardAmount: 1n }]), hashCreateParams(vectors.operator, { ...params, rewardAmount: 1n }));
});

test('TypeScript and Solidity agree at deadline-1, deadline, deadline+1', async () => {
  for (const now of [99n, 100n, 101n]) {
    assert.equal(await call('canSubmit', [now, 100n, 110n]), canSubmit(now, 100n, 110n));
    assert.equal(await call('canSubmit', [now, 110n, 100n]), canSubmit(now, 110n, 100n));
    assert.equal(await call('canReview', [now, 100n]), canReview(now, 100n));
    assert.equal(await call('afterReleaseOrReject', [now, 100n]), afterReleaseOrReject(now, 100n));
  }
  assert.equal(await call('canSubmit', [100n, 100n, 110n]), false);
  assert.equal(await call('canReview', [100n, 100n]), false);
  assert.equal(await call('afterReleaseOrReject', [100n, 100n]), 5);
});

test('lease clamps to task deadline and handles uint64 edge without addition overflow', async () => {
  for (const [now, seconds, deadline] of [[100n, 180, 200n], [100n, 10, 200n], [(1n << 64n) - 10n, 100, (1n << 64n) - 1n]] as const) {
    assert.equal(await call('leaseExpiry', [now, seconds, deadline]), leaseExpiry(now, seconds, deadline));
  }
});
