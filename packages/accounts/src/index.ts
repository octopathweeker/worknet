import { getSmartAccountsEnvironment, ExecutionMode, type Delegation } from '@metamask/smart-accounts-kit';
import { DelegationManager } from '@metamask/smart-accounts-kit/contracts';
import { SIGNABLE_DELEGATION_TYPED_DATA, hashDelegation, createCaveatBuilder } from '@metamask/smart-accounts-kit/utils';
import { keccak256, stringToHex, parseAbi, type Address, type Hex } from 'viem';

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
