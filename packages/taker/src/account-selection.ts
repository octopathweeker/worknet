import { readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const accountStateDirectory = () => resolve(process.env.WORKNET_TAKER_STATE_DIR ?? join(homedir(), '.config/worknet'));
export const lastAccountPath = () => join(accountStateDirectory(), 'last-account.json');
export type LastAccount = { configPath: string; origin: string; executorId: string; name: string };

/** Explicit selection wins. Missing/broken previous accounts must never trigger a new enrollment. */
export function selectConfigPath(explicit: string | undefined, stateDirectory = accountStateDirectory()) {
  if (explicit !== undefined) return resolve(explicit);
  let raw: string;
  try { raw = readFileSync(join(stateDirectory, 'last-account.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return join(stateDirectory, 'taker.json');
    throw error;
  }
  try {
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || typeof saved.configPath !== 'string' || !isAbsolute(saved.configPath) || !statSync(saved.configPath).isFile()) throw new Error('Invalid previous account');
    return saved.configPath as string;
  } catch {
    throw new Error('LAST_ACCOUNT_UNAVAILABLE: restore the previous account config or explicitly select WORKNET_TAKER_CONFIG. Do not initialize a replacement account.');
  }
}

/** Only public metadata is persisted, after successful execution operations, never on status checks. */
export async function rememberAccount(account: LastAccount, stateDirectory = accountStateDirectory()) {
  const path = join(stateDirectory, 'last-account.json');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const saved = { version: 1, configPath: resolve(account.configPath), origin: account.origin,
    executorId: account.executorId, name: account.name, updatedAt: new Date().toISOString() };
  await writeFile(temporary, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
