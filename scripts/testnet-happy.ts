import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { erc20Abi, type Address, type Hex } from 'viem';
import { loadConfig, chainClient, transferTask, json } from '@agent-task/runtime';
import type { TaskSpec } from '@agent-task/protocol';

const config = loadConfig(process.env.DEMO_CONFIG ?? '.runtime/testnet/config.json');
if (config.mode !== 'testnet' || config.chainId !== 10143) throw new Error('Monad Testnet required');
const base = process.env.REQUESTER_API_URL ?? 'http://127.0.0.1:8790';
if (!process.env.REQUESTER_API_TOKEN) throw new Error('Requester API token required');
const raw = JSON.parse(await readFile(process.env.DEMO_CONFIG ?? '.runtime/testnet/config.json', 'utf8'));
const accounts = JSON.parse(await readFile('.runtime/testnet-accounts/addresses.public.json', 'utf8'));
const client = chainClient(config); const directory = '.runtime/testnet/happy-cases'; await mkdir(directory, { recursive: true });
const results: unknown[] = [];
async function api(route: string, body?: unknown) {
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(60000), headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.REQUESTER_API_TOKEN}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`API_${response.status}`); return response.json();
}
for (let index = 1; index <= 10; index++) {
  const filename = `${directory}/${index}.json`; let spec: TaskSpec;
  try { spec = JSON.parse(await readFile(filename, 'utf8')) as TaskSpec; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; spec = transferTask(config, `testnet-acceptance/happy-${index}`, Number((await client.getBlock()).timestamp) + 900, raw.fixture); await writeFile(filename, JSON.stringify(spec, null, 2) + '\n'); }
  const worker = accounts.addresses.transferWorker as Address; const requester = accounts.addresses.requester as Address;
  const before = { workerNative: await client.getBalance({ address: worker }), requesterNative: await client.getBalance({ address: requester }), workerUSDC: await client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [worker] }) };
  const started = Date.now(); const hired = await api('/api/hire', { spec });
  const retry = await api('/api/hire', { spec }); if (retry.taskId !== hired.taskId) throw new Error('Request retry created another task');
  const deadline = Date.now() + 120000; let detail;
  while (Date.now() < deadline) {
    detail = await api(`/api/tasks/${hired.taskId}`);
    if (detail.status >= 3) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (detail?.status !== 3 || detail.worker.toLowerCase() !== worker.toLowerCase() || !detail.verification.some((e: { verdict: string; attempt: string; resultHash: string }) => e.verdict === 'accept' && e.attempt === detail.attempt && e.resultHash === detail.resultHash)) throw new Error(`Task ${hired.taskId} did not pass verified settlement`);
  const hashes = [...new Set<Hex>(detail.events.map((event: { transactionHash: Hex }) => event.transactionHash))];
  const receipts = [];
  for (const hash of hashes) {
    const receipt = await client.getTransactionReceipt({ hash }); const transaction = await client.getTransaction({ hash });
    if (receipt.status !== 'success') throw new Error('Lifecycle transaction reverted');
    receipts.push({ hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, gasLimit: transaction.gas, effectiveGasPrice: receipt.effectiveGasPrice });
  }
  const after = { workerNative: await client.getBalance({ address: worker }), requesterNative: await client.getBalance({ address: requester }), workerUSDC: await client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [worker] }) };
  // A previously completed case can be inspected again without creating/spending again.
  if (hired.transactionHash && after.workerUSDC - before.workerUSDC !== BigInt(spec.reward.amountBaseUnits)) throw new Error('Worker USDC balance delta mismatch');
  const firstBlock = await client.getBlock({ blockNumber: receipts[0]!.blockNumber }); const lastBlock = await client.getBlock({ blockNumber: receipts.at(-1)!.blockNumber });
  results.push({ case: index, taskId: hired.taskId, resumed: !hired.transactionHash, observedElapsedMs: Date.now() - started, onchainElapsedSeconds: lastBlock.timestamp - firstBlock.timestamp, before, after, requesterNativeDeltaWei: before.requesterNative - after.requesterNative, workerNativeDeltaWei: before.workerNative - after.workerNative, receipts, detail });
  await writeFile('docs/stages/M5/testnet-happy-paths.json', json({ chainId: 10143, manager: config.manager, vault: config.vault, checkedAt: new Date().toISOString(), expectedCases: 10, completedCases: results.length, cases: results }) + '\n');
  console.log(json({ case: index, taskId: hired.taskId, status: 'verified-and-settled', elapsedMs: Date.now() - started }));
}
