import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
const binary = process.argv[2] ?? 'forge';
const candidates = [process.env.FOUNDRY_BIN && path.join(process.env.FOUNDRY_BIN, binary), path.resolve('.tools/foundry', binary), path.join(homedir(), '.foundry/bin', binary)].filter(Boolean);
const executable = candidates.find(existsSync);
if (!executable) throw new Error('Install official Foundry >=1.8; set FOUNDRY_BIN to its directory.');
const version = spawnSync(executable, ['--version'], { encoding: 'utf8' });
if (!/Version: (?:1\.(?:[89]|[1-9][0-9])\.|[2-9]\.)/.test(version.stdout)) throw new Error(`Unsupported Foundry: ${version.stdout}`);
const localSolc = path.resolve('.tools/solc-0.8.37');
const result = spawnSync(executable, process.argv.slice(3), {
  stdio: 'inherit',
  env: { ...process.env, ...(binary === 'forge' && existsSync(localSolc) ? { FOUNDRY_SOLC: localSolc } : {}) },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
