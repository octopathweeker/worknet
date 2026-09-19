import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const config = '.runtime/testnet/config.json';
await access(config); await access('.runtime/local-model/model.env'); await access('.runtime/testnet-accounts/workspace.env');
const port = Number(process.env.API_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid API_PORT');
await new Promise((resolve, reject) => { const s = createServer(); s.once('error', () => reject(new Error(`Port ${port} is occupied; keep only one Requester process.`))); s.listen(port, '127.0.0.1', () => s.close(resolve)); });
const children = []; let stopping = false;
async function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children.toReversed()) child.kill('SIGTERM');
  await Promise.race([Promise.all(children.map(c => c.exitCode !== null || c.signalCode ? undefined : new Promise(r => c.once('exit', r)))), new Promise(r => setTimeout(r, 10000))]);
  for (const child of children) if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  console.log('Testnet services stopped; chain, signed outboxes, objects and snapshots preserved.'); process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop());
function launch(name, args) {
  const log = createWriteStream(`.runtime/testnet/${name}.log`, { flags: 'a', mode: 0o600 });
  const env = { ...process.env, API_PORT: String(port), REQUESTER_API_URL: `http://127.0.0.1:${port}` };
  // Each child loads only its role-specific key. Never inherit an unrelated signer.
  delete env.AGENT_PRIVATE_KEY; delete env.DEPLOYER_PRIVATE_KEY; delete env.REQUESTER_API_TOKEN; delete env.STORAGE_UPLOAD_TOKEN;
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  child.stdout.pipe(log); child.stderr.pipe(log);
  child.once('error', error => { console.error(`${name}: ${error.message}`); void stop(1); });
  child.once('exit', (code, signal) => { log.end(); if (!stopping) { console.error(`${name} exited (${code ?? signal}); stopping companion services.`); void stop(1); } });
}
async function ready(url, check) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (stopping) throw new Error('Services stopped');
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok && await check(await r.json())) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Service not ready: ${url}`);
}
try {
  // The local model is a pre-existing, explicitly configured service. Do not
  // silently switch models or fall back to synthetic answers if it is unavailable.
  await ready('http://127.0.0.1:11435/api/tags', value => value.models.some(m => m.name === 'qwen3:4b-instruct-2507-q4_K_M'));
  launch('requester', ['--env-file=.runtime/testnet-accounts/requester.env', '--env-file=.runtime/testnet-accounts/workspace.env', '--env-file=.runtime/local-model/model.env', 'apps/daemon/dist/main.js']);
  await ready(`http://127.0.0.1:${port}/api/health`, value => value.ready);
  launch('transfer-worker', ['--env-file=.runtime/testnet-accounts/transferWorker.env', 'apps/cli/dist/main.js', 'worker', '--config', config, '--db', '.runtime/testnet/transfer-worker.db']);
  launch('research-worker', ['--env-file=.runtime/testnet-accounts/researchWorker.env', '--env-file=.runtime/local-model/model.env', 'apps/cli/dist/main.js', 'worker', '--config', config, '--db', '.runtime/testnet/research-worker.db', '--capability', 'research']);
  launch('workspace-bridge', ['--env-file=.runtime/testnet-accounts/requester.env', '--import', 'tsx', 'scripts/workspace-bridge.ts']);
  launch('dashboard-publisher', ['--env-file=.runtime/testnet-accounts/requester.env', '--import', 'tsx', 'scripts/publish-dashboard.ts']);
  const manifest = { startedAt: new Date().toISOString(), pid: process.pid, childPids: children.map(c => c.pid), config, api: `http://127.0.0.1:${port}`, logs: '.runtime/testnet' };
  await writeFile('.runtime/testnet/services.json', JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ ...manifest, message: 'Existing Testnet deployment resumed. No funding, authorization or new task was created.' }));
} catch (error) { console.error(error.message); await stop(1); }
