import { loadConfig, publicFailure } from '@agent-task/runtime';
import type { WorkspaceCommand } from '@agent-task/workspace';
const config = loadConfig(process.env.DEMO_CONFIG ?? '.runtime/testnet/config.json');
const api = process.env.REQUESTER_API_URL ?? 'http://127.0.0.1:8790';
if (!process.env.STORAGE_UPLOAD_TOKEN || !process.env.REQUESTER_API_TOKEN) throw new Error('Bridge credentials missing');
const remoteHeaders = { authorization: `Bearer ${process.env.STORAGE_UPLOAD_TOKEN}`, 'content-type': 'application/json' };
const localHeaders = { authorization: `Bearer ${process.env.REQUESTER_API_TOKEN}`, 'content-type': 'application/json' };
let stopped = false; for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopped = true; });
async function publishOnce() {
  const r = await fetch(`${api}/api/workspace/snapshot`, { headers: localHeaders, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`WORKSPACE_SNAPSHOT_${r.status}`);
  const r2 = await fetch(new URL('/bridge/workspace', config.storageUrl), { method: 'PUT', headers: remoteHeaders, body: await r.text(), signal: AbortSignal.timeout(15000) });
  if (!r2.ok) throw new Error(`WORKSPACE_PUBLISH_${r2.status}`);
}
let publication: Promise<void> | undefined;
function publish() { return publication ??= publishOnce().finally(() => { publication = undefined; }); }
const timer = setInterval(() => { if (!stopped) void publish().catch(e => console.error(publicFailure(e))); }, 4000);
try {
  await publish(); console.log('Workspace bridge connected; only validated semantic commands are forwarded.');
  while (!stopped) {
    try {
      const r = await fetch(new URL('/bridge/commands', config.storageUrl), { headers: remoteHeaders, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`BRIDGE_READ_${r.status}`);
      const { command } = await r.json() as { command: WorkspaceCommand | null };
      if (command) {
        const response = await fetch(`${api}/api/workspace/command`, { method: 'POST', headers: localHeaders, body: JSON.stringify(command), signal: AbortSignal.timeout(120000) });
        const data = await response.json();
        if (publication) await publication;
        await publish();
        const result = response.ok ? { status: 'complete', result: data.result } : { status: 'failed', error: data.error ?? '执行未完成，请重试原计划。' };
        const saved = await fetch(new URL(`/bridge/commands/${command.id}`, config.storageUrl), { method: 'PUT', headers: remoteHeaders, body: JSON.stringify(result), signal: AbortSignal.timeout(15000) });
        if (!saved.ok) throw new Error(`BRIDGE_ACK_${saved.status}`);
        console.log(JSON.stringify({ id: command.id, type: command.type, status: result.status }));
      }
    } catch (error) { console.error(publicFailure(error)); }
    if (!stopped) await new Promise(r => setTimeout(r, 1500));
  }
} finally { clearInterval(timer); await publication; }
