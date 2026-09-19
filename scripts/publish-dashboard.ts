import { canonicalJson, hashJson } from '@agent-task/protocol';
import { loadConfig, publicFailure } from '@agent-task/runtime';
import { writeFile } from 'node:fs/promises';

const config = loadConfig(process.env.DEMO_CONFIG ?? '.runtime/testnet/config.json');
if (config.mode !== 'testnet' || !process.env.STORAGE_UPLOAD_TOKEN) throw new Error('Testnet config and storage credential required');
const api = process.env.REQUESTER_API_URL ?? 'http://127.0.0.1:8790';
const get = async (route: string) => { const response = await fetch(api + route, { signal: AbortSignal.timeout(30000) }); if (!response.ok) throw new Error(`API_${response.status}`); return response.json(); };
let stopped = false; for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopped = true; });
do {
  try {
    const publicConfig = await get('/api/config'); const ids = (await get('/api/tasks')) as Array<{ taskId: string }>;
    const details: Record<string, unknown> = {}; const tasks = [];
    for (const { taskId } of ids) {
      const detail = await get(`/api/tasks/${taskId}`); details[taskId] = detail;
      const { events: _events, result: _result, ...task } = detail; tasks.push(task);
    }
    const snapshot = { schema: 'worknet-dashboard/1', config: publicConfig, budget: await get('/api/budget'), tasks, details };
    const response = await fetch(new URL('/dashboard', config.storageUrl), { method: 'PUT', headers: { authorization: `Bearer ${process.env.STORAGE_UPLOAD_TOKEN}`, 'content-type': 'application/json' }, body: canonicalJson(snapshot), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`PUBLISH_${response.status}`);
    const report = { publishedAt: new Date().toISOString(), url: config.storageUrl, taskCount: tasks.length, snapshotHash: hashJson(snapshot) };
    await writeFile('.runtime/testnet/public-dashboard.json', JSON.stringify(report, null, 2) + '\n');
    if (process.argv.includes('--once')) await writeFile('docs/stages/M5/public-dashboard.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } catch (error) { console.error(publicFailure(error)); if (process.argv.includes('--once')) { process.exitCode = 1; break; } }
  if (process.argv.includes('--once')) break;
  if (!stopped) await new Promise(resolve => setTimeout(resolve, 10000));
} while (!stopped);
