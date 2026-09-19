import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const command = process.argv[2] ?? 'serve';
const model = 'qwen3:4b-instruct-2507-q4_K_M';
const host = '127.0.0.1:11435';
if (!['serve', 'pull', 'config'].includes(command)) throw new Error('Commands: serve | pull | config');
await mkdir('.runtime/local-model', { recursive: true, mode: 0o700 });
await mkdir('.tools/ollama-models', { recursive: true });
if (command === 'config') {
  const response = await fetch(`http://${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok || !(await response.json()).models.some(m => m.name === model)) throw new Error('Start pnpm model:serve and complete pnpm model:pull first');
  await writeFile('.runtime/local-model/model.env', `LLM_BASE_URL=http://${host}/v1\nLLM_API_KEY=local-ollama\nLLM_MODEL=${model}\nLLM_TIMEOUT_MS=90000\n`, { mode: 0o600 });
  console.log('Local model environment written to .runtime/local-model/model.env (Ollama ignores the local placeholder key).');
} else {
  const child = spawn('ollama', command === 'serve' ? ['serve'] : ['pull', model], {
    stdio: 'inherit', env: { ...process.env, OLLAMA_HOST: host, OLLAMA_MODELS: path.resolve('.tools/ollama-models'), OLLAMA_NO_CLOUD: '1', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_CONTEXT_LENGTH: '8192' },
  });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  child.once('exit', code => { process.exitCode = code ?? 0; });
}
