import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { erc20Abi, type Hex } from 'viem';
import { loadConfig, chainClient, researchTask, json } from '@agent-task/runtime';
import type { TaskSpec } from '@agent-task/protocol';

const config = loadConfig(process.env.DEMO_CONFIG ?? '.runtime/testnet/config.json');
assert.equal(config.mode, 'testnet'); assert.equal(config.chainId, 10143);
const client = chainClient(config); const base = process.env.REQUESTER_API_URL ?? 'http://127.0.0.1:8790';
assert.ok(process.env.REQUESTER_API_TOKEN);
async function api(route: string, body?: unknown) {
  const r = await fetch(base + route, { signal: AbortSignal.timeout(60000), method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.REQUESTER_API_TOKEN}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) throw new Error(`API_${r.status}`); return r.json();
}
assert.equal((await api('/api/config')).llmAvailable, true);
const accounts = JSON.parse(await readFile('.runtime/testnet-accounts/addresses.public.json', 'utf8'));
const worker = accounts.addresses.researchWorker;
const filename = '.runtime/testnet/research-case.json'; let spec: TaskSpec;
try { spec = JSON.parse(await readFile(filename, 'utf8')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; spec = researchTask(config, 'testnet-acceptance/live-research-1', Number((await client.getBlock()).timestamp) + 900, 'llm'); await writeFile(filename, JSON.stringify(spec, null, 2) + '\n'); }
const before = await client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [worker] });
const started = Date.now(); const hired = await api('/api/hire', { spec });
assert.equal((await api('/api/hire', { spec })).taskId, hired.taskId);
console.log(json({ event: 'research-hired', ...hired }));
let detail: Awaited<ReturnType<typeof api>>; const limit = Date.now() + 330000;
while (Date.now() < limit) {
  detail = await api(`/api/tasks/${hired.taskId}`);
  if (detail.status >= 3) break;
  console.log(json({ taskId: hired.taskId, status: detail.status, attempt: detail.attempt, elapsedMs: Date.now() - started }));
  await new Promise(r => setTimeout(r, 10000));
}
const after = await client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [worker] });
const report = { checkedAt: new Date().toISOString(), chainId: config.chainId, taskId: hired.taskId, resumed: !hired.transactionHash, elapsedMs: Date.now() - started, beforeUSDC: before, afterUSDC: after, detail, passed: false, receipts: [] as unknown[] };
try {
  assert.equal(detail.status, 3); assert.equal(detail.worker.toLowerCase(), worker.toLowerCase()); assert.equal(detail.result.output.mode, 'llm');
  assert.match(detail.result.provenance.toolVersion, /^llm:qwen3:/);
  const evidence = detail.verification.find((e: any) => e.attempt === detail.attempt && e.resultHash === detail.resultHash);
  assert.equal(evidence.verdict, 'accept'); assert.ok(evidence.checks.every((c: any) => c.passed)); assert.ok(evidence.checks.some((c: any) => c.name === 'semantic-judge'));
  assert.ok(detail.events.some((e: any) => e.eventName === 'TaskSettled' && e.args.reason === 0));
  if (hired.transactionHash) assert.equal(after - before, 50000n);
  for (const hash of new Set<Hex>(detail.events.map((e: any) => e.transactionHash))) {
    const receipt = await client.getTransactionReceipt({ hash }); assert.equal(receipt.status, 'success');
    report.receipts.push({ hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice });
  }
  report.passed = true;
} finally { await writeFile('docs/stages/M5/testnet-research.json', json(report) + '\n'); }
console.log(json({ taskId: report.taskId, passed: report.passed, elapsedMs: report.elapsedMs, model: detail.result.provenance.toolVersion }));
