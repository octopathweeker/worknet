import { getSmartAccountsEnvironment, ExecutionMode, type Delegation } from '@metamask/smart-accounts-kit';
import { DelegationManager } from '@metamask/smart-accounts-kit/contracts';
import { SIGNABLE_DELEGATION_TYPED_DATA, hashDelegation, createCaveatBuilder } from '@metamask/smart-accounts-kit/utils';
import { keccak256, stringToHex, parseAbi, encodeAbiParameters, toFunctionSelector, type Address, type Hex } from 'viem';

export const ACCOUNT_CHAIN_ID = 10143;
export const accountEnvironment = getSmartAccountsEnvironment(ACCOUNT_CHAIN_ID);
export const delegatedImplementation = accountEnvironment.implementations.EIP7702StatelessDeleGatorImpl!;
export const factoryAbi = parseAbi([
  'function createVault(address owner) returns (address vault)',
  'function predictVault(address owner) view returns (address)',
  'function vaultOf(address owner) view returns (address)',
  'function taskManager() view returns (address)',
  'event VaultCreated(address indexed owner, address indexed vault)',
]);
export type AccountCall = { target: Address; value: bigint; callData: Hex };

/** Exact batch + one redemption + deadline: the sponsor cannot replace any call or amount. */
export function exactPermission(owner: Address, delegate: Address, calls: AccountCall[], intentId: string, validUntil: number): Delegation {
  if (!calls.length || calls.length > 8 || !Number.isSafeInteger(validUntil)) throw new Error('INVALID_PERMISSION');
  const builder = createCaveatBuilder(accountEnvironment);
  if (calls.length === 1) builder.addCaveat('exactExecution', { execution: calls[0]! });
  else builder.addCaveat('exactExecutionBatch', { executions: calls });
  return {
    delegator: owner, delegate,
    authority: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    caveats: builder.addCaveat('limitedCalls', { limit: 1 }).addCaveat('timestamp', { afterThreshold: 0, beforeThreshold: validUntil }).build(),
    salt: keccak256(stringToHex(`worknet/permission/1/${intentId}`)), signature: '0x',
  };
}
export function permissionTypedData(delegation: Delegation) {
  const { signature: _signature, caveats, ...message } = delegation;
  return {
    domain: { name: 'DelegationManager', version: '1', chainId: ACCOUNT_CHAIN_ID, verifyingContract: accountEnvironment.DelegationManager },
    types: SIGNABLE_DELEGATION_TYPED_DATA, primaryType: 'Delegation' as const,
    message: { ...message, salt: BigInt(message.salt), caveats: caveats.map(({ args: _args, ...caveat }) => caveat) },
  };
}
export function redeemPermission(delegation: Delegation, calls: AccountCall[]) {
  return { to: accountEnvironment.DelegationManager, data: DelegationManager.encode.redeemDelegations({ delegations: [[delegation]], modes: [calls.length === 1 ? ExecutionMode.SingleDefault : ExecutionMode.BatchDefault], executions: [calls] }) };
}
export function disablePermission(delegation: Delegation) {
  return { to: accountEnvironment.DelegationManager, data: DelegationManager.encode.disableDelegation({ delegation }) };
}
export function isSupportedDelegation(code: Hex | undefined): boolean { return code?.toLowerCase() === `0xef0100${delegatedImplementation.slice(2).toLowerCase()}`; }
export { hashDelegation };
export type { Delegation };

export const AGENT_SESSION_CALLS = 200;
export const AGENT_SESSION_SECONDS = 7 * 86400;
export type AgentSessionGrant = {
  id:string;owner:Address;signer:Address;manager:Address;token:Address;chainId:10143;
  validUntil:number;maxCalls:number;permission:Delegation;approved?:boolean;
  authorization?:{address:Address;chainId:number;nonce:number;r:Hex;s:Hex;yParity:number};
};
export function agentEnrollmentMessage(origin: string, id: string, name: string, tokenHash: Hex) {
  return `Worknet Agent enrollment v1\nOrigin: ${origin}\nID: ${id}\nName: ${name}\nCredential hash: ${tokenHash}\nChain: 10143`;
}
export const delegationStatusAbi = parseAbi(['function disabledDelegations(bytes32) view returns (bool)', 'function callCounts(address,bytes32) view returns (uint256)']);
/** Reusable worker authority. No token/native transfers, approvals or arbitrary calls. */
export function agentSessionPermission(owner: Address, signer: Address, manager: Address, id: string, validUntil: number): Delegation {
  if (owner.toLowerCase() === signer.toLowerCase() || !Number.isSafeInteger(validUntil) || validUntil <= 0) throw new Error('INVALID_PERMISSION');
  return {
    delegator: owner, delegate: signer, authority: `0x${'ff'.repeat(32)}`,
    caveats: createCaveatBuilder(accountEnvironment)
      .addCaveat('allowedTargets', { targets: [manager] })
      .addCaveat('allowedMethods', { selectors: [toFunctionSelector('claimTask(uint256)'), toFunctionSelector('submitResult(uint256,uint64,bytes32,string)')] })
      .addCaveat('valueLte', { maxValue: 0n })
      .addCaveat('limitedCalls', { limit: AGENT_SESSION_CALLS })
      .addCaveat('timestamp', { afterThreshold: 0, beforeThreshold: validUntil }).build(),
    salt: keccak256(stringToHex(`worknet/agent-session/1/${id}`)), signature: '0x',
  };
}

/** One zero-value submit for a specific task/attempt. The result hash is chosen later by the executor. */
export function taskSubmissionPermission(owner: Address, delegate: Address, manager: Address, taskId: bigint, attempt: bigint, intentId: string, validUntil: number): Delegation {
  if (taskId <= 0n || attempt <= 0n || attempt >= 2n ** 64n || !Number.isSafeInteger(validUntil)) throw new Error('INVALID_PERMISSION');
  return {
    delegator: owner, delegate, authority: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    caveats: createCaveatBuilder(accountEnvironment)
      .addCaveat('allowedTargets', { targets: [manager] })
      .addCaveat('allowedMethods', { selectors: [toFunctionSelector('submitResult(uint256,uint64,bytes32,string)')] })
      .addCaveat('allowedCalldata', { startIndex: 4, value: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }], [taskId, attempt]) })
      .addCaveat('valueLte', { maxValue: 0n })
      .addCaveat('limitedCalls', { limit: 1 })
      .addCaveat('timestamp', { afterThreshold: 0, beforeThreshold: validUntil }).build(),
    salt: keccak256(stringToHex(`worknet/task-submit/1/${intentId}`)), signature: '0x',
  };
}
