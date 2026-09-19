import type { FromSchema } from 'json-schema-to-ts';
import { LIMITS, PROTOCOL_VERSION } from './constants.js';

const decimal = { type: 'string', pattern: '^(0|[1-9][0-9]*)$', maxLength: 78 } as const;
const positive = { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 78 } as const;
const address = { type: 'string', pattern: '^0x[0-9a-f]{40}$', not: { const: '0x0000000000000000000000000000000000000000' } } as const;
const hash = { type: 'string', pattern: '^0x[0-9a-f]{64}$', not: { const: '0x' + '0'.repeat(64) } } as const;
const text = { type: 'string', minLength: 1, maxLength: 4096 } as const;
const version = { type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$', maxLength: 32 } as const;
const uri = { type: 'string', minLength: 1, maxLength: LIMITS.maxUriBytes, pattern: '^(https://|ipfs://|http://localhost[:/]|http://127\\.0\\.0\\.1[:/])' } as const;
const timestamp = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const header = {
  protocol: { const: PROTOCOL_VERSION }, settlementChainId: positive, taskManager: address,
} as const;

export const taskSpecSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'urn:agent-task:0.1:task-spec',
  type: 'object', additionalProperties: false,
  required: ['protocol', 'settlementChainId', 'taskManager', 'requester', 'clientRequestId', 'capability', 'capabilityVersion', 'title', 'instructions', 'input', 'outputSchema', 'reward', 'execution', 'verification'],
  properties: {
    ...header, requester: address, clientRequestId: hash,
    capability: { type: 'string', pattern: '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$', maxLength: 96 },
    capabilityVersion: version, title: { type: 'string', minLength: 1, maxLength: 160 },
    instructions: { type: 'string', minLength: 1, maxLength: 16384 },
    input: { type: 'object' }, outputSchema: { type: 'object' },
    reward: { type: 'object', additionalProperties: false, required: ['token', 'amountBaseUnits'], properties: { token: address, amountBaseUnits: positive } },
    execution: {
      type: 'object', additionalProperties: false, required: ['taskDeadline', 'claimLeaseSeconds', 'reviewWindowSeconds'],
      properties: {
        taskDeadline: timestamp,
        claimLeaseSeconds: { type: 'integer', minimum: 1, maximum: LIMITS.maxTaskLifetimeSeconds },
        reviewWindowSeconds: { type: 'integer', minimum: LIMITS.minReviewWindowSeconds, maximum: LIMITS.maxReviewWindowSeconds },
      },
    },
    verification: {
      type: 'object', additionalProperties: false, required: ['profile', 'profileVersion', 'criteria', 'unverifiableAction'],
      properties: {
        profile: text, profileVersion: version,
        criteria: { type: 'array', minItems: 1, maxItems: 32, items: text },
        unverifiableAction: { const: 'reject' },
      },
    },
  },
} as const;

export const resultManifestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'urn:agent-task:0.1:result-manifest',
  type: 'object', additionalProperties: false,
  required: ['protocol', 'settlementChainId', 'taskManager', 'taskId', 'attempt', 'worker', 'specHash', 'output', 'artifacts', 'provenance'],
  properties: {
    ...header, taskId: positive, attempt: positive, worker: address, specHash: hash, output: {},
    artifacts: {
      type: 'array', maxItems: 16,
      items: {
        type: 'object', additionalProperties: false, required: ['uri', 'hash', 'mediaType', 'sizeBytes'],
        properties: { uri, hash, mediaType: text, sizeBytes: { type: 'integer', minimum: 0, maximum: LIMITS.maxArtifactBytes } },
      },
    },
    provenance: {
      type: 'object', additionalProperties: false,
      properties: {
        sourceChainId: positive,
        blockRange: {
          type: 'object', additionalProperties: false, required: ['fromBlock', 'toBlock', 'toBlockHash'],
          properties: { fromBlock: decimal, toBlock: decimal, toBlockHash: hash },
        },
        sources: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['uri', 'retrievedAt'], properties: { uri, retrievedAt: timestamp, contentHash: hash } } },
        toolVersion: text,
      },
    },
    agentRef: { type: 'object', additionalProperties: false, required: ['chainId', 'registry', 'agentId'], properties: { chainId: positive, registry: address, agentId: decimal } },
  },
} as const;

export type TaskSpec = FromSchema<typeof taskSpecSchema>;
export type ResultManifest = FromSchema<typeof resultManifestSchema>;
