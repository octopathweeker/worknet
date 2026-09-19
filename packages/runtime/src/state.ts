import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const json = (value: unknown) => JSON.stringify(value, (_, item: unknown) => typeof item === 'bigint' ? item.toString() : item);

/** One local database per process; economic truth remains onchain. */
export class State {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, raw TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, block_number TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL);`);
  }
  get<T>(key: string): T | undefined { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(String(row.value)) as T : undefined; }
  set(key: string, value: unknown): void { this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, json(value)); }
  list<T>(prefix: string): Array<{ key: string; value: T }> {
    return this.db.prepare('SELECT key,value FROM kv WHERE substr(key,1,?)=? ORDER BY key').all(prefix.length, prefix).map(row => ({ key: String(row.key), value: JSON.parse(String(row.value)) as T }));
  }
  transaction<T>(work: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = work(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  close(): void { this.db.close(); }
}
