import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:net';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig, chainClient, getTask } from '@agent-task/runtime';
import { taskManagerAbi } from '@agent-task/contracts';
import { erc20Abi } from 'viem';

async function port(): Promise<number> { const s = createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const p = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return p; }
function process_(args: string[], env: NodeJS.ProcessEnv): { child: ChildProcess; output: () => string; completed: Promise<string> } {
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { output += chunk; });
  const completed = new Promise<string>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(output))); });
  void completed.catch(() => undefined); return { child, output: () => output, completed };
}
async function waitFor(check: () => Promise<boolean>, limit = 30000) { const until = Date.now() + limit; while (Date.now() < until) { if (await check().catch(() => false)) return; await new Promise(r => setTimeout(r, 200)); } throw new Error('Timeout waiting for condition'); }
async function stop(child: ChildProcess) { if (child.exitCode !== null) return; const ended = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM'); await Promise.race([ended, new Promise<void>(r => setTimeout(r, 2000))]); if (child.exitCode === null) child.kill('SIGKILL'); }

const SCORES: Record<string, number> = { 'judge-1': 4, 'judge-2': 3, 'judge-3': 2 };

test('judge quorum scores completion, settles onchain by median and refunds the rest', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'judge-quorum-'));
  const rpcPort = await port(); const storePort = await port(); const apiPort = await port(); const stubPort = await port(); const judgePorts = [await port(), await port(), await port()];
  const configPath = path.join(directory, 'config.json');
  const judgeUrls = judgePorts.map(p => `http://127.0.0.1:${p}`).join(',');
  const env = { ...process.env, LOCAL_RPC_URL: `http://127.0.0.1:${rpcPort}`, STORAGE_URL: `http://127.0.0.1:${storePort}`, DEMO_CONFIG: configPath, JUDGE_URLS: judgeUrls, STORAGE_UPLOAD_TOKEN: 'e2e-only-upload-token', API_PORT: String(apiPort), REQUESTER_API_TOKEN: 'e2e-only-requester-token-32chars', TYPESAFE_API_KEY: 'stub-key', TYPESAFE_BASE_URL: `http://127.0.0.1:${stubPort}` };
  const anvil = spawn(path.resolve(process.env.FOUNDRY_BIN ?? '.tools/foundry', 'anvil'), ['--network', 'monad', '--hardfork', 'MonadNine', '--chain-id', '31337', '--block-time', '1', '--host', '127.0.0.1', '--port', String(rpcPort), '--silent'], { stdio: 'ignore' });
  let storage: ReturnType<typeof process_> | undefined;
  let daemon: ReturnType<typeof process_> | undefined;
  const judges: ReturnType<typeof process_>[] = [];
  let stub: Server | undefined;
  const cli = (...args: string[]) => process_(['apps/cli/dist/main.js', ...args, '--config', configPath], env).completed;
  const readBody = (request: IncomingMessage) => new Promise<string>(resolve => { const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => resolve(Buffer.concat(chunks).toString())); });
  const send = (response: ServerResponse, code: number, value: unknown) => { response.setHeader('content-type', 'application/json'); response.writeHead(code).end(JSON.stringify(value)); };
  try {
    let rateLimited = false;
    stub = createHttpServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/health') return send(response, 200, { ok: true });
      if (request.method !== 'POST' || !request.url?.startsWith('/v1/systemone')) return send(response, 404, {});
      const body = JSON.parse(await readBody(request)) as { questions?: { completion?: { instructions?: { framing?: string } } } };
      const framing = body.questions?.completion?.instructions?.framing ?? '';
      const judge = /judge (judge-\d)/.exec(framing)?.[1];
      if (!rateLimited) { rateLimited = true; return send(response, 429, {}); } // First judge call retries with backoff.
      const score = SCORES[judge ?? ''] ?? 3;
      send(response, 200, { model: 'stub-jev', answers: { completion: { type: 'score', score } }, usage: { input_tokens: 0, output_tokens: 0 } });
    });
    await new Promise<void>(resolve => stub!.listen(stubPort, '127.0.0.1', resolve));
    await waitFor(async () => (await fetch(env.LOCAL_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })).ok);
    await process_(['--import', 'tsx', 'scripts/local-deploy.ts'], env).completed;
    storage = process_(['apps/cli/dist/main.js', 'storage', '--port', String(storePort), '--directory', path.join(directory, 'objects')], env);
    await waitFor(async () => (await fetch(env.STORAGE_URL)).status === 404);
    for (const index of [0, 1, 2]) {
      const judgeEnv = { ...env, JUDGE_PORT: String(judgePorts[index]), JUDGE_ID: `judge-${index + 1}`, JUDGE_ACCOUNT: String(5 + index) };
      judges.push(process_(['apps/judge/dist/main.js'], judgeEnv));
    }
    for (const index of [0, 1, 2]) await waitFor(async () => (await fetch(`http://127.0.0.1:${judgePorts[index]}/health`)).ok);
    const config = loadConfig(configPath); const client = chainClient(config);
    const judgeAccounts = await Promise.all([5, 6, 7].map(async index => (await client.readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'judges', args: [BigInt(index - 5)] })) as string));
    assert.equal(judgeAccounts.length, 3);

    // A judge must refuse to score content that does not match the committed hashes.
    const tampered = await fetch(`http://127.0.0.1:${judgePorts[0]}/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: {}, result: {}, taskId: '1', attempt: '1', resultHash: '0x' + 'ab'.repeat(32), specHash: '0x' + 'cd'.repeat(32) }) });
    assert.equal(tampered.status, 422);

    daemon = process_(['apps/daemon/dist/main.js'], env);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok);

    await cli('demo-quorum', '--key', 'quorum/full', '--db', path.join(directory, 'quorum-cli.db'));
    await waitFor(async () => (await getTask(client, config, 1n)).status === 3);
    const first = await getTask(client, config, 1n);
    const workerBalance1 = await client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [first.worker] }) as bigint;
    const vaultBalance1 = await client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [config.vault] }) as bigint;
    assert.equal(workerBalance1, 37500n); // median of 4/3/2 → 7500 bps of 50000.
    assert.equal(vaultBalance1, 50_000_000n - 50_000n + 12_500n);
    const verdict1 = await client.getContractEvents({ address: config.manager, abi: taskManagerAbi, eventName: 'VerdictSettled', args: { taskId: 1n }, fromBlock: BigInt(config.deploymentBlock) });
    assert.equal(verdict1[0]!.args.medianBps, 7500); assert.equal(verdict1[0]!.args.workerAmount, 37500n); assert.equal(verdict1[0]!.args.refundAmount, 12500n);
    const settle1 = await client.getContractEvents({ address: config.manager, abi: taskManagerAbi, eventName: 'TaskSettled', args: { taskId: 1n }, fromBlock: BigInt(config.deploymentBlock) });
    assert.equal(settle1[0]!.args.reason, 2); // JUDGE_VERDICT
    await waitFor(async () => {
      const detail = await (await fetch(`http://127.0.0.1:${apiPort}/api/tasks/1`, { headers: { authorization: `Bearer ${env.REQUESTER_API_TOKEN}` } })).json() as { verification?: Array<{ checks: Array<{ name: string }> }> };
      return detail.verification?.some(v => v.checks.some(check => check.name === 'quorum-median')) ?? false;
    });

    // 2-of-3 survives one judge going down; even verdict count takes the lower median
    // (scores 4 and 2 → bps 10000/5000 → lower middle 5000).
    await stop(judges[1]!.child);
    await cli('demo-quorum', '--key', 'quorum/partial', '--mode', 'partial', '--db', path.join(directory, 'quorum-cli.db'));
    await waitFor(async () => (await getTask(client, config, 2n)).status === 3);
    const second = await getTask(client, config, 2n);
    const workerBalance2 = await client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [second.worker] }) as bigint;
    const vaultBalance2 = await client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [config.vault] }) as bigint;
    assert.equal(workerBalance2, 37500n + 25000n); // median of 10000/5000 → lower middle 5000 bps.
    assert.equal(vaultBalance2, 50_000_000n - 100_000n + 12_500n + 25_000n);
    const verdict2 = await client.getContractEvents({ address: config.manager, abi: taskManagerAbi, eventName: 'VerdictSettled', args: { taskId: 2n }, fromBlock: BigInt(config.deploymentBlock) });
    assert.equal(verdict2[0]!.args.medianBps, 5000); assert.equal(verdict2[0]!.args.refundAmount, 25000n);
  } finally {
    for (const judge of judges) await stop(judge.child);
    if (daemon) await stop(daemon.child);
    if (storage) await stop(storage.child);
    await stop(anvil);
    await new Promise(resolve => stub?.close(() => resolve(undefined)));
    await rm(directory, { recursive: true, force: true });
  }
});
