import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { encodeFunctionData, encodeDeployData, erc20Abi, parseAbi, type Address, type Hex, type SignedAuthorization } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { taskManagerAbi, requesterVaultAbi } from '@agent-task/contracts';
import { exactPermission, permissionTypedData, redeemPermission, disablePermission, delegatedImplementation, factoryAbi, isSupportedDelegation, type AccountCall, type Delegation } from '@agent-task/accounts';
import { hashJson, canonicalJson } from '@agent-task/protocol/json';
import { capabilityId, clientRequestId } from '@agent-task/protocol';
import { client, TEST_USDC } from './testnet-common.js';
import { privateJson, persistPrivate, JournalWallet } from './platform-chain.js';

const keys = await privateJson<Record<string, Hex>>('accounts.private.json', () => { throw new Error('Run prepare-platform first'); });
const config = JSON.parse(await readFile('.runtime/platform/config.json', 'utf8')) as { manager: Address; factory: Address; storageUrl: string };
const alice = privateKeyToAccount(keys.alice!); const taker = privateKeyToAccount(keys.taker!);
const sponsor = new JournalWallet(keys.sponsor!, 'sponsor'); const operator = new JournalWallet(keys.operator!, 'operator');
const state = await privateJson<{ now: number; permissions: Record<string, Delegation>; checks: Record<string, unknown>; receipts: Record<string, string> }>('r2-state.json', () => ({ now: Math.floor(Date.now() / 1000), permissions: {}, checks: {}, receipts: {} }));
const save = () => persistPrivate('r2-state.json', state);
async function expectRevert(name: string, call: { to: Address; data: Hex; value?: bigint }) {
  let rejected = false;
  try { await client.call({ ...call, account: sponsor.account }); }
  catch (error) { const message = String(error); if (!/revert|execution reverted/i.test(message)) throw error; rejected = true; }
  assert(rejected, `${name}: expected contract rejection`); state.checks[name] = { passed: true, method: 'eth_call against deployed Testnet contracts' }; await save();
}
async function permission(name: string, account: typeof alice, calls: AccountCall[], expiry = state.now + 86400) {
  let p = state.permissions[name];
  if (!p) { p = exactPermission(account.address, sponsor.account.address, calls, `r2/${name}`, expiry); p.signature = await account.signTypedData(permissionTypedData(p)); state.permissions[name] = p; await save(); }
  return p;
}
async function execute(name: string, account: typeof alice, calls: AccountCall[]) {
  const p = await permission(name, account, calls); const receipt = await sponsor.send(name, redeemPermission(p, calls)); assert.equal(receipt.status, 'success'); state.receipts[name] = receipt.transactionHash; await save(); return p;
}
const call = (target: Address, callData: Hex): AccountCall => ({ target, value: 0n, callData });

// Set-code is tested independently from app execution. The failed call must NOT hide delegation state.
for (const [name, account] of [['alice', alice], ['taker', taker]] as const) {
  const auth = await privateJson<SignedAuthorization>(`authorization-${name}.json`, () => ({} as SignedAuthorization));
  let signed = auth;
  if (!auth.address) { signed = await account.signAuthorization({ chainId: 10143, contractAddress: delegatedImplementation, nonce: await client.getTransactionCount({ address: account.address }) }); await persistPrivate(`authorization-${name}.json`, signed); }
  if (name === 'taker') {
    const receipt = await sponsor.send(`delegate-${name}-failed-call`, { to: account.address, data: '0xdeadbeef', authorizationList: [signed], gas: 120000n });
    assert.equal(receipt.status, 'reverted');
    state.checks.delegationPersistsAfterRevert = { passed: isSupportedDelegation(await client.getCode({ address: account.address })), hash: receipt.transactionHash };
    assert(isSupportedDelegation(await client.getCode({ address: account.address })));
  } else { const receipt = await sponsor.send(`delegate-${name}`, { to: account.address, authorizationList: [signed], data: '0x' }); assert.equal(receipt.status, 'success'); }
  assert(isSupportedDelegation(await client.getCode({ address: account.address })));
  assert.equal(await client.getBalance({ address: account.address }), 0n);
  await save();
}
const vault = await client.readContract({ address: config.factory, abi: factoryAbi, functionName: 'predictVault', args: [alice.address] });
const setupCalls = [
  call(config.factory, encodeFunctionData({ abi: factoryAbi, functionName: 'createVault', args: [alice.address] })),
  call(TEST_USDC, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault, 500000n] })),
  call(vault, encodeFunctionData({ abi: requesterVaultAbi, functionName: 'deposit', args: [500000n] })),
  call(vault, encodeFunctionData({ abi: requesterVaultAbi, functionName: 'authorizeAgent', args: [operator.account.address, { validAfter: BigInt(state.now), validUntil: BigInt(state.now + 86400), maxPerTask: 200000n, maxTotalCommitment: 500000n }] })),
];
const setupPermission = await permission('setup', alice, setupCalls);
await expectRevert('changedBatchRejected', redeemPermission(setupPermission, [setupCalls[0]!]));
await execute('setup', alice, setupCalls);
await expectRevert('replayRejected', redeemPermission(setupPermission, setupCalls));
assert.equal((await client.readContract({ address: vault, abi: requesterVaultAbi, functionName: 'owner' })).toLowerCase(), alice.address.toLowerCase());
state.checks.factoryFromDelegatedAccount = { passed: true, vault, owner: alice.address };

const noop = [call(config.factory, encodeFunctionData({ abi: factoryAbi, functionName: 'createVault', args: [alice.address] }))];
const expired = await permission('expired', alice, noop, state.now - 1);
await expectRevert('expiredPermissionRejected', redeemPermission(expired, noop));
const revoked = await permission('revoked', alice, noop);
const disable = disablePermission(revoked); await execute('revoke-permission', alice, [call(disable.to, disable.data)]);
await expectRevert('revokedPermissionRejected', redeemPermission(revoked, noop));

// No native value can leave a zero-MON delegated account. A funded reserve-boundary probe is run separately.
const valueCall: AccountCall[] = [{ target: sponsor.account.address, value: 1n, callData: '0x' }];
const valuePermission = await permission('native-value', alice, valueCall);
await expectRevert('zeroMonCannotSpendNative', redeemPermission(valuePermission, valueCall));

const uploadEnv = await readFile('.runtime/testnet-accounts/deployer.env', 'utf8');
const uploadToken = /^STORAGE_UPLOAD_TOKEN=(.+)$/m.exec(uploadEnv)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
async function put(value: unknown) { const hash = hashJson(value); const uri = `${config.storageUrl}/objects/${hash}`; const r = await fetch(uri, { method: 'PUT', headers: { authorization: `Bearer ${uploadToken}` }, body: canonicalJson(value) }); assert(r.ok, `upload ${r.status}`); return { hash, uri }; }
const spec = { protocol: 'agent-task/0.1', settlementChainId: '10143', taskManager: config.manager.toLowerCase(), requester: vault.toLowerCase(), clientRequestId: clientRequestId('r2/delegated-taker/1'), capability: 'test.delegated-account', capabilityVersion: '1.0.0', title: 'R2 独立账户调用与奖励归属验证', instructions: '返回已承诺的 account 字符串，由 requester 精确核对后验收。', input: { account: taker.address.toLowerCase() }, outputSchema: { type: 'object', required: ['account'], properties: { account: { const: taker.address.toLowerCase() } }, additionalProperties: false }, reward: { token: TEST_USDC.toLowerCase(), amountBaseUnits: '10000' }, execution: { taskDeadline: state.now + 3600, claimLeaseSeconds: 600, reviewWindowSeconds: 300 }, verification: { profile: 'exact-account', profileVersion: '1.0.0', criteria: ['交付 account 与承诺地址相同'], unverifiableAction: 'reject' } };
const stored = await put(spec);
const params = { capabilityId: capabilityId(spec.capability, spec.capabilityVersion), specHash: stored.hash, specURI: stored.uri, rewardAmount: 10000n, taskDeadline: BigInt(spec.execution.taskDeadline), claimLeaseSeconds: 600, reviewWindowSeconds: 300 };
const created = await operator.send('r2-create-task', { to: vault, data: encodeFunctionData({ abi: requesterVaultAbi, functionName: 'createTask', args: [spec.clientRequestId, params] }) }); assert.equal(created.status, 'success');
const id = await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getTaskByRequestId', args: [vault, spec.clientRequestId] });
await execute('taker-claim', taker, [call(config.manager, encodeFunctionData({ abi: taskManagerAbi, functionName: 'claimTask', args: [id] }))]);
let task = await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getTask', args: [id] }); assert.equal(task.worker.toLowerCase(), taker.address.toLowerCase());
const result = { protocol: 'agent-task/0.1', settlementChainId: '10143', taskManager: config.manager.toLowerCase(), taskId: id.toString(), attempt: task.attempt.toString(), worker: taker.address.toLowerCase(), specHash: stored.hash, output: { account: taker.address.toLowerCase() }, artifacts: [], provenance: { toolVersion: 'r2-account-probe/1' } };
const output = await put(result);
await execute('taker-submit', taker, [call(config.manager, encodeFunctionData({ abi: taskManagerAbi, functionName: 'submitResult', args: [id, task.attempt, output.hash, output.uri] }))]);
assert.equal(result.output.account, spec.input.account);
const accepted = await operator.send('r2-accept-result', { to: vault, data: encodeFunctionData({ abi: requesterVaultAbi, functionName: 'acceptResult', args: [id, task.attempt, output.hash] }) }); assert.equal(accepted.status, 'success');
task = await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getTask', args: [id] }); assert.equal(task.status, 3);
assert.equal(await client.readContract({ address: TEST_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [taker.address] }), 10000n);
assert.equal(await client.getBalance({ address: taker.address }), 0n);
state.checks.takerPaidAtUserAddress = { passed: true, taskId: id.toString(), worker: task.worker, reward: '10000', MON: '0', acceptanceHash: accepted.transactionHash };
// Isolate Monad-specific probes from the user accounts used in the product verification.
const probeKey = await privateJson<Hex>('reserve-probe-key.private.json', generatePrivateKey); const probeAccount = privateKeyToAccount(probeKey);
const probeAuth = await privateJson<SignedAuthorization>('reserve-probe-authorization.json', () => ({} as SignedAuthorization));
if (!probeAuth.address) { Object.assign(probeAuth, await probeAccount.signAuthorization({ chainId: 10143, contractAddress: delegatedImplementation, nonce: await client.getTransactionCount({ address: probeAccount.address }) })); await persistPrivate('reserve-probe-authorization.json', probeAuth); }
assert.equal((await sponsor.send('reserve-probe-activate', { to: probeAccount.address, authorizationList: [probeAuth], data: '0x' })).status, 'success');
assert.equal((await sponsor.send('reserve-probe-fund', { to: probeAccount.address, value: 1000000000000000n })).status, 'success');
const reserveCall: AccountCall[] = [{ target: sponsor.account.address, value: 1n, callData: '0x' }];
const reservePermission = await permission('reserve-decrease', probeAccount, reserveCall);
const reserveReceipt = await sponsor.send('reserve-decrease-must-revert', { ...redeemPermission(reservePermission, reserveCall), gas: 300000n });
assert.equal(reserveReceipt.status, 'reverted'); assert.equal(await client.getBalance({ address: probeAccount.address }), 1000000000000000n);
state.checks.monadReserve = { passed: true, account: probeAccount.address, MONWei: '1000000000000000', attemptedDecreaseWei: '1', hash: reserveReceipt.transactionHash };
const deployerEnv = await readFile('.runtime/testnet-accounts/deployer.env', 'utf8');
const deployerKey = /^DEPLOYER_PRIVATE_KEY=(.+)$/m.exec(deployerEnv)![1]!.trim().replace(/^['"]|['"]$/g, '') as Hex;
const probeArtifact = JSON.parse(await readFile('contracts/out/MonadAccountProbe.sol/MonadAccountProbe.json', 'utf8'));
const probeDeployed = await new JournalWallet(deployerKey, 'deployer').send('deploy-monad-account-probe', { data: encodeDeployData({ abi: probeArtifact.abi, bytecode: probeArtifact.bytecode.object }) });
assert(probeDeployed.contractAddress);
const createAuth = await privateJson<SignedAuthorization>('create-probe-authorization.json', () => ({} as SignedAuthorization));
if (!createAuth.address) { Object.assign(createAuth, await probeAccount.signAuthorization({ chainId: 10143, contractAddress: probeDeployed.contractAddress, nonce: await client.getTransactionCount({ address: probeAccount.address }) })); await persistPrivate('create-probe-authorization.json', createAuth); }
const createReceipt = await sponsor.send('delegated-create-must-revert', { to: probeAccount.address, authorizationList: [createAuth], data: encodeFunctionData({ abi: parseAbi(['function spawn() returns (address)']), functionName: 'spawn' }), gas: 300000n });
assert.equal(createReceipt.status, 'reverted'); state.checks.monadDelegatedCreate = { passed: true, hash: createReceipt.transactionHash, factoryCreationPassed: true };
// Explicitly remove this test-only delegation; no application funds live in this account.
const clearAuth = await privateJson<SignedAuthorization>('clear-probe-authorization.json', () => ({} as SignedAuthorization));
if (!clearAuth.address) { Object.assign(clearAuth, await probeAccount.signAuthorization({ chainId: 10143, contractAddress: '0x0000000000000000000000000000000000000000', nonce: await client.getTransactionCount({ address: probeAccount.address }) })); await persistPrivate('clear-probe-authorization.json', clearAuth); }
assert.equal((await sponsor.send('clear-probe-delegation', { to: probeAccount.address, authorizationList: [clearAuth], data: '0x' })).status, 'success');
await save(); await mkdir('docs/stages/R2', { recursive: true });
await writeFile('docs/stages/R2/testnet-verification.json', JSON.stringify({ at: new Date().toISOString(), chainId: 10143, implementation: delegatedImplementation, wallet: 'viem local software wallet; extension Human validation pending', checks: state.checks, receipts: state.receipts }, null, 2) + '\n');
console.log('R2 software-wallet Testnet verification saved; Human extension validation remains pending.');
