import { z } from 'zod';

export const goalInputSchema = z.object({
  goal: z.string().trim().min(8, '请具体描述希望得到的结果，至少 8 个字。').max(2000),
  kind: z.enum(['research', 'analysis', 'team']),
  sourceUrls: z.array(z.string().url().max(512)).max(3).default([]),
  fromBlock: z.string().regex(/^\d+$/).optional(),
  toBlock: z.string().regex(/^\d+$/).optional(),
}).strict();
export type GoalInput = z.infer<typeof goalInputSchema>;
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string().uuid(), type: z.literal('plan'), input: goalInputSchema }).strict(),
  z.object({ id: z.string().uuid(), type: z.literal('launch'), goalId: z.string().uuid() }).strict(),
  z.object({ id: z.string().uuid(), type: z.literal('worker-control'), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), accepting: z.boolean() }).strict(),
]);
export type WorkspaceCommand = z.infer<typeof commandSchema>;
export type GoalTask = { kind: 'research' | 'analysis'; title: string; description: string; reward: string; taskId?: string; spec?: unknown };
export type GoalRecord = { id: string; title: string; input: GoalInput; createdAt: string; launchedAt?: string; tasks: GoalTask[]; status: 'draft' | 'launching' | 'running' | 'completed' | 'attention'; error?: string };
export type GoalView = Omit<GoalRecord, 'tasks'> & { tasks: Array<GoalTask & { status?: number; worker?: string; result?: unknown; verification?: any[]; events?: any[]; attempt?: string; resultHash?: string }> };
export type WorkerView = { address: string; capability: string; accepting: boolean; online: boolean; phase: string; updatedAt: string; taskId?: string; earned: string; gasBalance: string; completed: number; recent: Array<{ at: string; event: string; taskId?: string }>; error?: string };
export type WorkspaceSnapshot = { updatedAt: string; goals: GoalView[]; workers: WorkerView[]; connected: boolean; modelAvailable: boolean; sourceHosts: string[]; budget: any; config: any };
export type CommandReply = { id: string; status: 'queued' | 'complete' | 'failed'; result?: any; error?: string; createdAt: number };

const encoder = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const unb64 = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
async function key(secret: string) { return crypto.subtle.importKey('raw', encoder.encode(`worknet-session-v1:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
export async function equalSecret(actual: string, expected: string) {
  if (actual.length > 512 || expected.length < 24) return false;
  const [a, b] = await Promise.all([actual, expected].map(s => crypto.subtle.digest('SHA-256', encoder.encode(s))));
  const aa = new Uint8Array(a!); const bb = new Uint8Array(b!); let diff = 0; for (let i = 0; i < aa.length; i++) diff |= aa[i]! ^ bb[i]!; return diff === 0;
}
export async function sessionCookie(secret: string, origin: string, secure = true) {
  const payload = b64(encoder.encode(JSON.stringify({ exp: Date.now() + 8 * 3600000, origin, nonce: crypto.randomUUID() })));
  const signature = b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload))));
  return `worknet_session=${payload}.${signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? '; Secure' : ''}`;
}
export async function validSession(cookie: string | null, secret: string | undefined, origin: string) {
  if (!secret || secret.length < 24 || !cookie || cookie.length > 4096) return false;
  try {
    const token = cookie.split(';').map(p => p.trim()).find(p => p.startsWith('worknet_session='))?.slice(16);
    const [payload, signature] = token?.split('.') ?? []; if (!payload || !signature) return false;
    if (!await crypto.subtle.verify('HMAC', await key(secret), unb64(signature), encoder.encode(payload))) return false;
    const data = JSON.parse(new TextDecoder().decode(unb64(payload))); return Number.isSafeInteger(data.exp) && data.exp > Date.now() && data.origin === origin;
  } catch { return false; }
}
