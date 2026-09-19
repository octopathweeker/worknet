import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { mnemonicToAccount } from 'viem/accounts';
import { bytesToHex, type Hex } from 'viem';
import { loadConfig, checkChain, State, Signer, HttpStorage, startStorage, Requester, transferTask, WorkerRuntime, transferHandler, Reviewer, configuredModel, researchTask, researchHandler, researchVerifier, json, workerAccepting, writeWorkerReport, publicFailure, type WorkerReport } from '@agent-task/runtime';
import { parseTaskSpec } from '@agent-task/protocol';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string', default: '.runtime/config.json' }, db: { type: 'string' },
  file: { type: 'string' }, port: { type: 'string', default: '8787' }, directory: { type: 'string', default: '.runtime/objects' },
  account: { type: 'string' }, once: { type: 'boolean', default: false }, key: { type: 'string', default: 'demo/transfer-1' },
  capability: { type: 'string', default: 'transfer' }, mode: { type: 'string', default: 'extractive' },
} });
const command = positionals[0]; const log = (event: unknown) => console.log(json(event));
if (command === 'storage') {
  const token = process.env.STORAGE_UPLOAD_TOKEN;
  if (!token) throw new Error('STORAGE_UPLOAD_TOKEN is required');
  const server = await startStorage({ directory: values.directory!, port: Number(values.port), token });
  log({ event: 'storage-ready', port: Number(values.port) });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
} else {
  const config = loadConfig(values.config!); await checkChain(config);
  const accountIndex = Number(values.account ?? (command === 'worker' ? '2' : '1'));
  let privateKey = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
  if (config.mode === 'local-demo') {
    if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > 9) throw new Error('Invalid dev account');
    const account = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: accountIndex });
    privateKey = bytesToHex(account.getHdKey().privateKey!);
  }
  if (!privateKey) throw new Error('AGENT_PRIVATE_KEY is required outside local-demo');
  const state = new State(values.db ?? path.join(path.dirname(values.config!), `account-${accountIndex}.db`));
  const signer = new Signer(config, state, privateKey); const storage = new HttpStorage(config.storageUrl, process.env.STORAGE_UPLOAD_TOKEN);
  const requester = new Requester(signer, state, storage);
  let stopped = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopped = true; });
  try {
    if (command === 'budget') log(await requester.budget());
    else if (command === 'hire') {
      if (!values.file) throw new Error('--file TaskSpec.json is required');
      log(await requester.hire(parseTaskSpec(await readFile(values.file, 'utf8'))));
    } else if (command === 'demo-task') {
      const raw = JSON.parse(await readFile(values.config!, 'utf8'));
      const specKey = `demo-spec:${values.key}`;
      const spec = state.get<ReturnType<typeof transferTask>>(specKey) ?? transferTask(config, values.key!, Number((await signer.client.getBlock()).timestamp) + 900, raw.fixture);
      state.set(specKey, spec); log(await requester.hire(spec));
    } else if (command === 'research-task') {
      if (!['extractive', 'llm'].includes(values.mode!)) throw new Error('Unknown research mode');
      const key = `research-spec:${values.key}`;
      const spec = state.get<ReturnType<typeof researchTask>>(key) ?? researchTask(config, values.key!, Number((await signer.client.getBlock()).timestamp) + 900, values.mode as 'extractive' | 'llm');
      state.set(key, spec); log(await requester.hire(spec));
    } else if (command === 'reviewer') {
      const reviewer = new Reviewer(requester, researchVerifier(config.sourceHosts, configuredModel()), log);
      log({ event: 'reviewer-ready', account: signer.account.address });
      do { try { await reviewer.tick(); } catch (error) { log({ event: 'reviewer-error', error: String(error).slice(0, 500) }); if (values.once) throw error; }
        if (!values.once && !stopped) await new Promise(resolve => setTimeout(resolve, 1000));
      } while (!values.once && !stopped);
    } else if (command === 'worker') {
      const directory = path.dirname(values.config!);
      const report: WorkerReport = { address: signer.account.address, capability: values.capability === 'research' ? 'research.web' : 'analysis.token-transfers', accepting: true, updatedAt: new Date().toISOString(), phase: 'idle', recent: [] };
      let reporting: Promise<void> = Promise.resolve();
      const publish = () => { reporting = reporting.then(async () => { report.accepting = await workerAccepting(directory, report.address); report.updatedAt = new Date().toISOString(); await writeWorkerReport(directory, report); }).catch(() => undefined); };
      const workerLog = (data: unknown) => {
        log(data); const event = data as { event: string; taskId?: string; error?: unknown };
        if (event.event === 'executing') { report.phase = 'working'; if (event.taskId) report.taskId = event.taskId; delete report.error; }
        if (event.event === 'submitted' || event.event === 'timeout-settlement') { report.phase = 'idle'; delete report.taskId; }
        if (event.event === 'task-error') { report.phase = 'attention'; report.error = publicFailure(event.error); }
        report.recent = [{ at: new Date().toISOString(), event: event.event, ...(event.taskId ? { taskId: event.taskId } : {}) }, ...report.recent].slice(0, 12); publish();
      };
      const worker = new WorkerRuntime(signer, state, storage, values.capability === 'research' ? [researchHandler(config.sourceHosts, configuredModel())] : [transferHandler], workerLog);
      const heartbeat = setInterval(publish, 2000); publish();
      log({ event: 'worker-ready', account: signer.account.address });
      try {
        do { try { const current = loadConfig(values.config!); config.sourceHosts.splice(0, config.sourceHosts.length, ...current.sourceHosts); await worker.tick({ acceptNewTasks: await workerAccepting(directory, signer.account.address) }); }
          catch (error) { report.error = publicFailure(error); log({ event: 'worker-error', error: String(error).slice(0, 500) }); if (values.once) throw error; }
          if (!values.once && !stopped) await new Promise(resolve => setTimeout(resolve, 2500));
        } while (!values.once && !stopped);
      } finally { clearInterval(heartbeat); await reporting; }
    } else throw new Error('Commands: storage | budget | hire --file | demo-task | worker | reviewer');
  } finally { await signer.close(); state.close(); }
}
