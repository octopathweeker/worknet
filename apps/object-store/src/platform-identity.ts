import { agentRefSchema, manifestAgentRef, verifyWorkerBinding, type IdentitySnapshot } from '@agent-task/identity';
import { z } from 'zod';
import type { Address } from 'viem';
import type { Env } from './index.js';
import { platformClient, platformConfig } from './platform-api.js';

/** Operator-configured references only. No user-supplied RPCs or registry addresses. */
export const identityConfigSchema = z.object({
  registry: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  workers: z.record(z.string().regex(/^0x[0-9a-f]{40}$/), agentRefSchema),
}).strict();
export async function workerIdentity(env: Env, worker: Address): Promise<IdentitySnapshot | undefined> {
  if (!env.ERC8004_CONFIG) return undefined;
  const config = identityConfigSchema.parse(JSON.parse(env.ERC8004_CONFIG));
  const ref = config.workers[worker.toLowerCase()];
  if (!ref) return undefined;
  if (ref.chainId !== '10143') throw new Error('IDENTITY_CHAIN_MISMATCH');
  return verifyWorkerBinding(platformClient(platformConfig(env)), ref, worker, [config.registry as Address]);
}
export async function identityManifestFields(env: Env, worker: Address) {
  const snapshot = await workerIdentity(env, worker);
  if (!snapshot) return {};
  // The referenced, immutable artifact carries the historical verification block.
  const { canonicalJson, hashJson } = await import('@agent-task/protocol/json');
  const evidence = { schema: 'worknet-identity/1', ...snapshot };
  const hash = hashJson(evidence); const bytes = new TextEncoder().encode(canonicalJson(evidence));
  await env.DB!.prepare('INSERT OR IGNORE INTO objects(hash,body,created_at) VALUES (?,?,?)').bind(hash, canonicalJson(evidence), Date.now()).run();
  return { agentRef: manifestAgentRef(snapshot), identityArtifact: { uri: `${platformConfig(env).storageUrl}/objects/${hash}`, hash, mediaType: 'application/vnd.worknet.identity+json', sizeBytes: bytes.byteLength } };
}
