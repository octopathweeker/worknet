import { requesterVaultAbi, taskManagerAbi } from '@agent-task/contracts';
import { clientRequestId, hashJson, toCreateTaskParams, validateCreationWindow, validateTaskSpec, validateResultManifest, assertSubmissionBinding, hashCreateParams, type TaskSpec } from '@agent-task/protocol';
import { erc20Abi, type Hex, type Address } from 'viem';
import { getTask, type Signer } from './chain.js';
import { State } from './state.js';
import { HttpStorage } from './storage.js';

export class Requester {
  constructor(readonly signer: Signer, readonly state: State, readonly storage: HttpStorage) {}
  async budget() {
    const { config, client, account } = this.signer;
    const authorization = await client.readContract({ address: config.vault, abi: requesterVaultAbi, functionName: 'getAuthorization', args: [account.address] });
    const balance = await client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [config.vault] });
    const remaining = authorization.maxTotalCommitment - authorization.committed;
    const paused = await client.readContract({ address: config.vault, abi: requesterVaultAbi, functionName: 'paused' });
    const now = (await client.getBlock()).timestamp;
    const effectiveActive = authorization.active && !paused && now >= authorization.validAfter && now < authorization.validUntil;
    return { ...authorization, paused, effectiveActive, vaultBalance: balance, remaining, newCommitmentCapacity: effectiveActive ? balance < remaining ? balance : remaining : 0n, agent: account.address };
  }
  async hire(specInput: TaskSpec): Promise<{ taskId: bigint; transactionHash?: Hex }> {
    const spec = validateTaskSpec(specInput); const { config, client, account } = this.signer;
    if (spec.settlementChainId !== String(config.chainId) || spec.taskManager !== config.manager.toLowerCase() || spec.requester !== config.vault.toLowerCase() || spec.reward.token !== config.token.toLowerCase()) throw new Error('HIRE_NETWORK_OR_ACCOUNT_MISMATCH');
    const key = `request:${config.chainId}:${config.manager}:${config.vault}:${spec.clientRequestId}`;
    const fingerprint = hashJson(spec);
    const stored = this.state.transaction(() => {
      const prior = this.state.get<{ fingerprint: Hex; spec: TaskSpec; uri: string; taskId?: string }>(key);
      if (prior && prior.fingerprint !== fingerprint) throw new Error('REQUEST_ID_CONFLICT');
      const reserved = prior ?? { fingerprint, spec, uri: new URL(`/objects/${fingerprint}`, this.storage.baseUrl).href };
      this.state.set(key, reserved); return reserved;
    });
    const params = toCreateTaskParams(stored.spec, stored.uri);
    const found = await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getTaskByRequestId', args: [config.vault, spec.clientRequestId as Hex] });
    if (found !== 0n) {
      const onchainHash = await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getRequestParamsHash', args: [config.vault, spec.clientRequestId as Hex] });
      if (onchainHash !== hashCreateParams(account.address, params)) throw new Error('REQUEST_ID_CONFLICT');
      this.state.set(key, { ...stored, taskId: found.toString() }); return { taskId: found };
    }
    await this.storage.put(stored.spec);
    const budget = await this.budget(); const now = (await client.getBlock()).timestamp;
    if (!budget.effectiveActive) throw new Error('AUTHORIZATION_INACTIVE');
    validateCreationWindow(spec, Number(now), Number(budget.validUntil));
    if (params.rewardAmount > budget.maxPerTask || params.rewardAmount > budget.newCommitmentCapacity) throw new Error('BUDGET_EXCEEDED');
    const hash = await this.signer.write(config.vault, requesterVaultAbi, 'createTask', [spec.clientRequestId, params], `create:${spec.clientRequestId}`);
    const taskId = await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getTaskByRequestId', args: [config.vault, spec.clientRequestId as Hex] });
    this.state.set(key, { ...stored, taskId: taskId.toString() }); return { taskId, transactionHash: hash };
  }
  async submission(id: bigint) {
    const task = await getTask(this.signer.client, this.signer.config, id);
    if (task.status !== 2 && task.status !== 3) throw new Error('NO_SUBMISSION');
    const result = validateResultManifest(await this.storage.get(task.resultURI, task.resultHash));
    assertSubmissionBinding(result, { settlementChainId: String(this.signer.config.chainId), taskManager: this.signer.config.manager.toLowerCase(), taskId: id.toString(), attempt: task.attempt.toString(), worker: task.worker.toLowerCase(), specHash: task.specHash });
    return { task, result };
  }
  async accept(id: bigint, attempt: bigint, hash: Hex) { return this.signer.write(this.signer.config.vault, requesterVaultAbi, 'acceptResult', [id, attempt, hash], `accept:${id}:${attempt}:${hash}`); }
  async reject(id: bigint, attempt: bigint, hash: Hex, reason: Hex) { return this.signer.write(this.signer.config.vault, requesterVaultAbi, 'rejectResult', [id, attempt, hash, reason], `reject:${id}:${attempt}:${hash}`); }
  async settleByVerdict(id: bigint, attempt: bigint, hash: Hex, completionBps: number[], signatures: Hex[]) { return this.signer.write(this.signer.config.manager, taskManagerAbi, 'settleWithVerdicts', [id, attempt, hash, completionBps, signatures], `verdict:${id}:${attempt}:${hash}`); }
  async cancel(id: bigint) { return this.signer.write(this.signer.config.vault, requesterVaultAbi, 'cancelTask', [id], `cancel:${id}`); }
}

export function transferTask(config: Signer['config'], logicalKey: string, deadline: number, input: { token: Address; fromBlock: string; toBlock: string }): TaskSpec {
  return {
    protocol: 'agent-task/0.1', settlementChainId: String(config.chainId), taskManager: config.manager.toLowerCase(), requester: config.vault.toLowerCase(), clientRequestId: clientRequestId(logicalKey),
    capability: 'analysis.token-transfers', capabilityVersion: '1.0.0', title: '分析链上 Transfer 事件',
    instructions: '对给定 token 与固定区块闭区间完整查询 Transfer 日志，返回事件数与原始单位金额总和。',
    input: { sourceChainId: String(config.chainId), ...input, token: input.token.toLowerCase() },
    outputSchema: { type: 'object', additionalProperties: false, required: ['eventCount', 'totalAmountBaseUnits'], properties: { eventCount: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' }, totalAmountBaseUnits: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' } } },
    reward: { token: config.token.toLowerCase(), amountBaseUnits: '50000' },
    execution: { taskDeadline: deadline, claimLeaseSeconds: 180, reviewWindowSeconds: 300 },
    verification: { profile: 'rpc-transfer-aggregate', profileVersion: '1.0.0', criteria: ['事件数与金额总和可由相同区块范围完整复算'], unverifiableAction: 'reject' },
  };
}
