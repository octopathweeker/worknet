import { taskManagerAbi } from '@agent-task/contracts';
import { encodeAbiParameters, keccak256, stringToBytes, type Address } from 'viem';
import { hashJson } from './json.js';
import { validateTaskSpec } from './validation.js';
import type { TaskSpec } from './schemas.js';

export type CreateTaskParams = {
  capabilityId: `0x${string}`; specHash: `0x${string}`; specURI: string; rewardAmount: bigint;
  taskDeadline: bigint; claimLeaseSeconds: number; reviewWindowSeconds: number;
};

export function capabilityId(name: string, version: string) {
  return keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [name, version]));
}
export function clientRequestId(logicalKey: string) {
  if (!logicalKey.isWellFormed() || !logicalKey.length || stringToBytes(logicalKey).length > 256) throw new Error('INVALID_REQUEST_KEY');
  return keccak256(stringToBytes(logicalKey));
}
export function toCreateTaskParams(spec: TaskSpec, specURI: string): CreateTaskParams {
  validateTaskSpec(spec);
  if (!specURI.length || stringToBytes(specURI).length > 512 || !specURI.isWellFormed()) throw new Error('INVALID_SPEC_URI');
  return {
    capabilityId: capabilityId(spec.capability, spec.capabilityVersion), specHash: hashJson(spec), specURI,
    rewardAmount: BigInt(spec.reward.amountBaseUnits), taskDeadline: BigInt(spec.execution.taskDeadline),
    claimLeaseSeconds: spec.execution.claimLeaseSeconds, reviewWindowSeconds: spec.execution.reviewWindowSeconds,
  };
}
// Derived from compiled Solidity: field order has exactly one source of truth.
const create = taskManagerAbi.find((item) => item.type === 'function' && item.name === 'createTask')!;
export function hashCreateParams(operator: Address, params: CreateTaskParams) {
  return keccak256(encodeAbiParameters([create.inputs[1], create.inputs[2]], [operator, params]));
}

/** Compare downloaded requirements with independently fetched onchain state. */
export function assertTaskSpecBinding(spec: TaskSpec, expected: {
  settlementChainId: string; taskManager: string; requester: string;
  clientRequestId: string; settlementToken: string; params: CreateTaskParams;
}): void {
  validateTaskSpec(spec);
  for (const key of ['settlementChainId', 'taskManager', 'requester', 'clientRequestId'] as const) {
    if (spec[key] !== expected[key]) throw new Error(`TASK_BINDING_MISMATCH: ${key}`);
  }
  if (spec.reward.token !== expected.settlementToken) throw new Error('TASK_BINDING_MISMATCH: token');
  const actual = toCreateTaskParams(spec, expected.params.specURI);
  for (const key of ['capabilityId', 'specHash', 'rewardAmount', 'taskDeadline', 'claimLeaseSeconds', 'reviewWindowSeconds'] as const) {
    if (actual[key] !== expected.params[key]) throw new Error(`TASK_BINDING_MISMATCH: ${key}`);
  }
}
