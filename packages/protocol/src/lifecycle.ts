import { TaskStatus, UINT64_MAX } from './constants.js';

function timestamp(...values: bigint[]) { for (const n of values) if (n < 0n || n > UINT64_MAX) throw new Error('INVALID_TIMESTAMP'); }
export function leaseExpiry(now: bigint, leaseSeconds: number, deadline: bigint): bigint {
  timestamp(now, deadline);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0 || leaseSeconds > 0xffffffff) throw new Error('INVALID_LEASE');
  const candidate = now + BigInt(leaseSeconds);
  return candidate < deadline ? candidate : deadline;
}
export function canSubmit(now: bigint, lease: bigint, deadline: bigint): boolean { timestamp(now, lease, deadline); return now < lease && now < deadline; }
export function canReview(now: bigint, deadline: bigint): boolean { timestamp(now, deadline); return now < deadline; }
export function afterReleaseOrReject(now: bigint, deadline: bigint) { timestamp(now, deadline); return now < deadline ? TaskStatus.OPEN : TaskStatus.EXPIRED; }
