export const PROTOCOL_VERSION = 'agent-task/0.1' as const;
export const TaskStatus = { OPEN: 0, CLAIMED: 1, SUBMITTED: 2, SETTLED: 3, CANCELLED: 4, EXPIRED: 5 } as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];
export const SettlementReason = { REQUESTER_ACCEPT: 0, REVIEW_TIMEOUT: 1 } as const;
export const LIMITS = {
  maxJsonBytes: 256 * 1024, maxDepth: 64, maxUriBytes: 512,
  maxArtifactBytes: 5 * 1024 * 1024, maxTaskLifetimeSeconds: 86400,
  minReviewWindowSeconds: 60, maxReviewWindowSeconds: 1800,
} as const;
export const UINT128_MAX = (1n << 128n) - 1n;
export const UINT64_MAX = (1n << 64n) - 1n;
