import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { rememberAccount, selectConfigPath } from '../packages/taker/src/account-selection.js';
import { TakerClient } from '../packages/taker/src/client.js';

test('new sessions reuse the last executed account, explicit selection wins, and metadata excludes credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worknet-selection-'));
  try {
    assert.equal(selectConfigPath(undefined, directory), join(directory, 'taker.json'));
    const previous = join(directory, 'claude.json');
    await writeFile(previous, '{}');
    await rememberAccount({ configPath: previous, origin: 'https://platform.test', executorId: 'saved-agent', name: 'Claude', token: 'never-copy', executionKey: 'never-copy' } as any, directory);
    assert.equal(selectConfigPath(undefined, directory), previous);
    assert.equal(selectConfigPath(join(directory, 'explicit.json'), directory), join(directory, 'explicit.json'));
    const text = await readFile(join(directory, 'last-account.json'), 'utf8');
    assert(!text.includes('never-copy'));
    assert.equal((await stat(join(directory, 'last-account.json'))).mode & 0o777, 0o600);
    await rm(previous);
    assert.throws(() => selectConfigPath(undefined, directory), /LAST_ACCOUNT_UNAVAILABLE/);
    assert.equal(selectConfigPath(join(directory, 'explicit.json'), directory), join(directory, 'explicit.json'), 'explicit recovery remains possible');
    await writeFile(join(directory, 'last-account.json'), 'broken JSON');
    assert.throws(() => selectConfigPath(undefined, directory), /LAST_ACCOUNT_UNAVAILABLE/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('status and failed work never change the last account; successful progress and uploads do', async () => {
  const original = globalThis.fetch;
  let saved = 0, fail = false;
  globalThis.fetch = async () => new Response(JSON.stringify(fail ? { code: 'GRANT_EXPIRED' } : { ok: true }), { status: fail ? 403 : 200 });
  const client = new TakerClient('https://platform.test', undefined, undefined, async () => { saved++; });
  try {
    await client.status();
    assert.equal(saved, 0);
    fail = true;
    await assert.rejects(client.upload(crypto.randomUUID(), {}), /GRANT_EXPIRED/);
    assert.equal(saved, 0);
    fail = false;
    await client.upload(crypto.randomUUID(), {});
    await client.progress(crypto.randomUUID(), { id: crypto.randomUUID(), summary: 'Checked references' });
    assert.equal(saved, 2);
  } finally { globalThis.fetch = original; }
});

test('client-info works without credentials and unknown commands fail instead of pretending to report progress', () => {
  const cli = resolve('packages/taker/src/cli.ts');
  const info = spawnSync(process.execPath, ['--import', 'tsx', cli, 'client-info'], { encoding: 'utf8', env: { ...process.env, WORKNET_TAKER_CONFIG: '/nonexistent/worknet-test-account.json' } });
  assert.equal(info.status, 0, info.stderr);
  const data = JSON.parse(info.stdout);
  assert(data.capabilities.includes('progress-reporting'));
  assert(data.capabilities.includes('remember-last-account'));
  const unknown = spawnSync(process.execPath, ['--import', 'tsx', cli, 'misspelled-progress'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command/);
  assert.equal(unknown.stdout, '');
});

test('an MCP process pins its implicit account rather than following another process mid-task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worknet-session-selection-'));
  try {
    const a = join(directory, 'a.json'), b = join(directory, 'b.json');
    await writeFile(a, '{}'); await writeFile(b, '{}');
    await rememberAccount({ configPath: a, origin: 'https://platform.test', executorId: 'a', name: 'A' }, directory);
    const code = `import {configPath,loadConfig} from './packages/taker/src/config.ts';
      import {rm} from 'node:fs/promises';
      import {rememberAccount} from './packages/taker/src/account-selection.ts';
      const first=configPath();
      await rememberAccount({configPath:${JSON.stringify(b)},origin:'https://platform.test',executorId:'b',name:'B'});
      const pinned=configPath();await rm(first);let error='';try{await loadConfig();}catch(e){error=e.message;}
      console.log(JSON.stringify({paths:[first,pinned],error}));`;
    const env: NodeJS.ProcessEnv = { ...process.env, WORKNET_TAKER_STATE_DIR: directory };
    delete env.WORKNET_TAKER_CONFIG;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    const output=JSON.parse(result.stdout);assert.deepEqual(output.paths, [a, a]);assert.match(output.error,/LAST_ACCOUNT_UNAVAILABLE/);
    assert.equal(selectConfigPath(undefined, directory), b, 'the next process uses the newly recorded account');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
