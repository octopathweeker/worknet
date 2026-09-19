import { requesterVaultAbi, taskManagerAbi } from '@agent-task/contracts';
import { assertTaskSpecBinding, canonicalJson, hashJson, validateTaskSpec, type TaskSpec, type ResultManifest } from '@agent-task/protocol';
import type { Hex } from 'viem';
import { getTask, getCachedTask, scanTasks } from './chain.js';
import { Requester } from './requester.js';
import { transferHandler, type HandlerContext } from './worker.js';
import { checkOutputSchema } from './schema.js';
import { publicFailure } from './errors.js';

export interface Check { name: string; passed: boolean; detail: string; }
export interface Evidence {
  protocol: 'agent-task/0.1'; settlementChainId: string; taskManager: string; taskId: string; attempt: string;
  specHash: Hex; resultHash: Hex; profile: string; profileVersion: string;
  verdict: 'accept' | 'reject' | 'unverifiable'; checks: Check[]; checkedAt: string;
}
export type ResearchVerifier = (spec: TaskSpec, result: ResultManifest, context: HandlerContext) => Promise<Check[]>;

export async function verify(requester: Requester, id: bigint, research?: ResearchVerifier): Promise<Evidence> {
  const { signer, storage } = requester; const { config, client } = signer;
  const task = await getTask(client, config, id);
  const checks: Check[] = [];
  let outcome: Evidence['verdict'] = 'unverifiable'; let profile = 'unknown'; let profileVersion = 'unknown';
  try {
    const { result } = await requester.submission(id);
    for (const artifact of result.artifacts) {
      const bytes = await storage.getBytes(artifact.uri, artifact.hash as Hex);
      if (bytes.length !== artifact.sizeBytes) throw new Error('ARTIFACT_SIZE_MISMATCH');
    }
    const spec = validateTaskSpec(await storage.get(task.specURI, task.specHash));
    profile = spec.verification.profile; profileVersion = spec.verification.profileVersion;
    assertTaskSpecBinding(spec, { settlementChainId: String(config.chainId), taskManager: config.manager.toLowerCase(), requester: task.requester.toLowerCase(), clientRequestId: spec.clientRequestId, settlementToken: config.token.toLowerCase(), params: task });
    const mapped = await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getTaskByRequestId', args: [task.requester, spec.clientRequestId as Hex] });
    if (mapped !== id) throw new Error('REQUEST_ID_BINDING_MISMATCH');
    checks.push({ name: 'integrity-and-binding', passed: true, detail: 'task, attempt, wallet and committed JSON match' });
    const schema = await checkOutputSchema(spec.outputSchema, result.output); checks.push(schema);
    if (!schema.passed) outcome = 'reject';
    else {
      const remainingMs = Number(task.reviewDeadline - (await client.getBlock()).timestamp - 30n) * 1000;
      if (remainingMs <= 0) throw new Error('VERIFICATION_WINDOW_EXHAUSTED');
      const context = { signal: AbortSignal.timeout(Math.min(spec.capability === 'research.web' ? 90000 : 30000, remainingMs)), client, chainId: config.chainId };
      if (spec.capability === 'analysis.token-transfers' && profile === 'rpc-transfer-aggregate' && profileVersion === '1.0.0') {
        const expected = await transferHandler.execute(spec, context);
        checks.push({ name: 'rpc-full-recomputation', passed: canonicalJson(expected.output) === canonicalJson(result.output) && canonicalJson(expected.provenance.blockRange) === canonicalJson(result.provenance.blockRange) && expected.provenance.sourceChainId === result.provenance.sourceChainId, detail: 'full bounded Transfer log recomputation + block hash comparison' });
      } else if (spec.capability === 'research.web' && research && profile === 'research-sources-and-judge' && profileVersion === '1.0.0') checks.push(...await research(spec, result, context));
      else throw new Error('UNSUPPORTED_VERIFICATION_PROFILE');
      outcome = checks.every(check => check.passed) ? 'accept' : 'reject';
    }
  } catch (error) {
    checks.push({ name: 'verification-available', passed: false, detail: publicFailure(error) });
  }
  return { protocol: 'agent-task/0.1', settlementChainId: String(config.chainId), taskManager: config.manager.toLowerCase(), taskId: id.toString(), attempt: task.attempt.toString(), specHash: task.specHash, resultHash: task.resultHash, profile, profileVersion, verdict: outcome, checks, checkedAt: new Date().toISOString() };
}

export class Reviewer {
  constructor(readonly requester: Requester, readonly research?: ResearchVerifier, readonly log: (event: unknown) => void = console.log) {}
  async tick(): Promise<void> {
    const { signer, state } = this.requester; const { config, client } = signer;
    const ids = await scanTasks(client, config, state);
    const [authorization, paused] = await Promise.all([
      client.readContract({ address: config.vault, abi: requesterVaultAbi, functionName: 'getAuthorization', args: [signer.account.address] }),
      client.readContract({ address: config.vault, abi: requesterVaultAbi, functionName: 'paused' }),
    ]);
    for (const id of ids) {
      const actionRetryKey = `review-action-retry:${config.chainId}:${config.manager}:${id}`;
      if ((state.get<{ nextAt: number }>(actionRetryKey)?.nextAt ?? 0) > Date.now()) continue;
      try {
      const task = await getCachedTask(client, config, state, id);
      if (task.status >= 3) continue;
      if (task.requester.toLowerCase() !== config.vault.toLowerCase()) continue;
      const now = (await client.getBlock()).timestamp;
      if ((task.status === 0 || task.status === 1) && now >= task.taskDeadline) {
        await signer.write(config.manager, taskManagerAbi, 'expireTask', [id], `expire:${id}`); continue;
      }
      if (task.status !== 2) continue;
      if (now >= task.reviewDeadline) continue; // Never relabel optimistic settlement as verified.
      // Reauthorization starts a new epoch. Old escrow remains valid, but only Owner
      // may review those tasks; one old task must not block this epoch's queue.
      if (paused || !authorization.active || now < authorization.validAfter || now >= authorization.validUntil) continue;
      const authority = await client.readContract({ address: config.vault, abi: requesterVaultAbi, functionName: 'getTaskAuthority', args: [id] });
      if (authority.operator.toLowerCase() !== signer.account.address.toLowerCase() || authority.epoch !== authorization.epoch) continue;
      const key = `verification:${config.chainId}:${config.manager}:${id}:${task.attempt}:${task.resultHash}`;
      let evidence = state.get<Evidence>(key);
      const retry = state.get<{ count: number; nextAt: string }>(`retry:${key}`) ?? { count: 0, nextAt: '0' };
      if (!evidence || evidence.verdict === 'unverifiable' && retry.count < 3 && now >= BigInt(retry.nextAt)) {
        evidence = await verify(this.requester, id, this.research); state.set(key, evidence);
        state.set(`retry:${key}`, { count: retry.count + 1, nextAt: (now + BigInt(Math.min(60, 5 * 2 ** retry.count))).toString() });
        this.log({ event: 'verified', taskId: id.toString(), verdict: evidence.verdict, checks: evidence.checks });
      }
      if (evidence.verdict === 'unverifiable' && now + 30n < task.reviewDeadline) continue;
      const fresh = await getTask(client, config, id);
      if (fresh.status !== 2 || fresh.attempt !== task.attempt || fresh.resultHash !== task.resultHash) continue;
      const current = (await client.getBlock()).timestamp;
      if (current >= fresh.reviewDeadline) continue;
      if (evidence.verdict === 'accept') await this.requester.accept(id, task.attempt, task.resultHash);
      else if (evidence.verdict === 'reject' || current + 30n >= fresh.reviewDeadline) await this.requester.reject(id, task.attempt, task.resultHash, hashJson(evidence));
      } catch (error) {
        state.set(actionRetryKey, { nextAt: Date.now() + 10000 });
        this.log({ event: 'review-task-error', taskId: id.toString(), error: error instanceof Error ? error.name : 'UnknownError' });
      }
    }
  }
}
