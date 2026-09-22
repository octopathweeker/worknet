import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const ports = { rpc: Number(process.env.DEMO_RPC_PORT ?? 8545), storage: Number(process.env.DEMO_STORAGE_PORT ?? 8787), api: Number(process.env.DEMO_API_PORT ?? 8788), model: Number(process.env.DEMO_MODEL_PORT ?? 8790), judge1: Number(process.env.DEMO_JUDGE1_PORT ?? 8791), judge2: Number(process.env.DEMO_JUDGE2_PORT ?? 8792), judge3: Number(process.env.DEMO_JUDGE3_PORT ?? 8793) };
if (new Set(Object.values(ports)).size !== 7 || Object.values(ports).some(p => !Number.isInteger(p) || p < 1024 || p > 65535)) throw new Error('Demo ports must be distinct integers in 1024–65535');
// Never attach to an arbitrary service already listening on a configured port.
for (const port of Object.values(ports)) await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', () => reject(new Error(`Port ${port} is occupied; stop your previous demo or set DEMO_*_PORT.`)));
  server.listen(port, '127.0.0.1', () => server.close(resolve));
});
const run = path.resolve('.runtime', `demo-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`);
await mkdir(run, { recursive: true, mode: 0o700 });
const config = path.join(run, 'config.json');
const base = {
  ...process.env, LOCAL_RPC_URL: `http://127.0.0.1:${ports.rpc}`, STORAGE_URL: `http://127.0.0.1:${ports.storage}`,
  API_PORT: String(ports.api), DEMO_CONFIG: config,
  JUDGE_URLS: `http://127.0.0.1:${ports.judge1},http://127.0.0.1:${ports.judge2},http://127.0.0.1:${ports.judge3}`,
  STORAGE_UPLOAD_TOKEN: randomBytes(32).toString('hex'), REQUESTER_API_TOKEN: randomBytes(32).toString('hex'), WORKSPACE_ACCESS_CODE: randomBytes(24).toString('base64url'),
};
// Each local demo gets fresh chain + databases. Local credentials are not printed.
delete base.AGENT_PRIVATE_KEY; delete base.DEPLOYER_PRIVATE_KEY;
if (!base.TYPESAFE_API_KEY) { base.TYPESAFE_API_KEY = 'local-stub-not-a-secret'; base.TYPESAFE_BASE_URL = `http://127.0.0.1:${ports.model}`; }
await writeFile(path.join(run, 'credentials.env'), `STORAGE_UPLOAD_TOKEN=${base.STORAGE_UPLOAD_TOKEN}\nREQUESTER_API_TOKEN=${base.REQUESTER_API_TOKEN}\n`, { mode: 0o600 });
await writeFile(path.join(run, 'WORKSPACE-ACCESS.md'), `# 本地工作区访问码\n\n${base.WORKSPACE_ACCESS_CODE}\n`, { mode: 0o600 });
let stopping = false;
const children = [];
async function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children.toReversed()) child.kill('SIGTERM');
  await Promise.race([Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => child.once('exit', resolve)))), new Promise(resolve => setTimeout(resolve, 4000))]);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  console.log(`Demo stopped. Logs and data preserved: ${run}`); process.exit(code);
}
process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
function launch(name, command, args, persistent = true, env = {}) {
  const output = createWriteStream(path.join(run, `${name}.log`), { mode: 0o600 });
  const child = spawn(command, args, { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  child.stdout.pipe(output); child.stderr.pipe(output);
  const complete = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      output.end();
      if (stopping) resolve();
      else if (persistent || code !== 0) reject(new Error(`${name} exited (${code ?? signal}); see ${name}.log in ${run}`));
      else resolve();
    });
  });
  if (persistent) complete.catch(error => { console.error(error.message); void stop(1); });
  return complete;
}
async function ready(url, options, test) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (stopping) throw new Error('Demo stopped');
    try { const response = await fetch(url, { ...options, signal: AbortSignal.timeout(1000) }); if (await test(response)) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Service not ready: ${url}`);
}
try {
  if (!existsSync('.tools/foundry/anvil') && !process.env.FOUNDRY_BIN) throw new Error('Run pnpm setup:tools first, or set FOUNDRY_BIN.');
  console.log(`Preparing local demo. Logs: ${run}`);
  await launch('build', 'pnpm', ['build'], false);
  await launch('contracts-build', 'pnpm', ['contracts:build'], false);
  // Resolve the official binary, not the unrelated "forge" CLI on PATH.
  const anvil = path.resolve(process.env.FOUNDRY_BIN ?? '.tools/foundry', 'anvil');
  void launch('anvil', anvil, ['--network', 'monad', '--hardfork', 'MonadNine', '--chain-id', '31337', '--host', '127.0.0.1', '--port', String(ports.rpc), '--block-time', '1', '--silent']);
  await ready(base.LOCAL_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) }, async r => (await r.json()).result === '0x7a69');
  void launch('storage', process.execPath, ['apps/cli/dist/main.js', 'storage', '--port', String(ports.storage), '--directory', path.join(run, 'objects')]);
  await ready(`${base.STORAGE_URL}/objects/0x${'0'.repeat(64)}`, {}, r => r.status === 404);
  if (!process.env.TYPESAFE_API_KEY) {
    void launch('judge-model-stub', process.execPath, ['scripts/judge-model-stub.mjs'], true, { STUB_PORT: String(ports.model) });
    await ready(`http://127.0.0.1:${ports.model}/health`, {}, async r => r.ok && (await r.json()).ok);
  }
  await launch('deploy', 'pnpm', ['exec', 'tsx', 'scripts/local-deploy.ts'], false);
  void launch('judge-1', process.execPath, ['apps/judge/dist/main.js'], true, { JUDGE_PORT: String(ports.judge1), JUDGE_ID: 'judge-1', JUDGE_ACCOUNT: '5' });
  void launch('judge-2', process.execPath, ['apps/judge/dist/main.js'], true, { JUDGE_PORT: String(ports.judge2), JUDGE_ID: 'judge-2', JUDGE_ACCOUNT: '6' });
  void launch('judge-3', process.execPath, ['apps/judge/dist/main.js'], true, { JUDGE_PORT: String(ports.judge3), JUDGE_ID: 'judge-3', JUDGE_ACCOUNT: '7' });
  await ready(`http://127.0.0.1:${ports.judge1}/health`, {}, async r => r.ok && (await r.json()).ok);
  await ready(`http://127.0.0.1:${ports.judge2}/health`, {}, async r => r.ok && (await r.json()).ok);
  await ready(`http://127.0.0.1:${ports.judge3}/health`, {}, async r => r.ok && (await r.json()).ok);
  void launch('requester', process.execPath, ['apps/daemon/dist/main.js']);
  await ready(`http://127.0.0.1:${ports.api}/api/health`, {}, async r => r.ok && (await r.json()).ready);
  void launch('worker-transfer', process.execPath, ['apps/cli/dist/main.js', 'worker', '--config', config, '--account', '2']);
  void launch('worker-research', process.execPath, ['apps/cli/dist/main.js', 'worker', '--config', config, '--account', '3', '--capability', 'research']);
  const manifest = { mode: 'local-demo', url: `http://127.0.0.1:${ports.api}`, run, config, startedAt: new Date().toISOString(), pid: process.pid, childPids: children.filter(c => c.exitCode === null).map(c => c.pid) };
  await writeFile(path.join(run, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile('.runtime/latest-demo.json', JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nWorknet ready: ${manifest.url}\nVault: 50 dUSDC; Agent budget: 10 dUSDC; no real assets.\nConfig: ${config}\nPress Ctrl+C to stop all demo processes.`);
} catch (error) { console.error(error.message); await stop(1); }
