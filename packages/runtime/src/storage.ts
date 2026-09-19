import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { canonicalBytes, hashJson, LIMITS, parseJsonBytes } from '@agent-task/protocol';
import { keccak256, type Hex } from 'viem';

export async function boundedBody(stream: AsyncIterable<Uint8Array>, max = LIMITS.maxJsonBytes): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of stream) { size += chunk.length; if (size > max) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function authorized(header: string | undefined, token: string): boolean {
  const a = Buffer.from(header ?? ''); const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function startStorage(options: { directory: string; token: string; port: number; host?: string }): Promise<Server> {
  if (options.token.length < 16) throw new Error('Upload token must be at least 16 characters');
  await mkdir(options.directory, { recursive: true });
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', 'application/json');
    try {
      const match = /^\/objects\/(0x[0-9a-f]{64})$/.exec(request.url ?? '');
      if (!match) { response.writeHead(404).end('{}'); return; }
      const hash = match[1]!; const filename = path.join(options.directory, `${hash}.json`);
      if (request.method === 'PUT') {
        if (!authorized(request.headers.authorization, options.token)) { response.writeHead(401).end('{}'); return; }
        const data = await boundedBody(request);
        const parsed = parseJsonBytes(data);
        if (keccak256(data) !== hash || hashJson(parsed) !== hash) throw new Error('HASH_MISMATCH_OR_NOT_CANONICAL');
        try { await writeFile(filename, data, { flag: 'wx', mode: 0o600 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        response.writeHead(201).end(JSON.stringify({ hash })); return;
      }
      if (request.method === 'GET') {
        const data = await readFile(filename);
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); response.end(data); return;
      }
      response.writeHead(405).end('{}');
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      response.writeHead(missing ? 404 : 400).end(JSON.stringify({ error: missing ? 'NOT_FOUND' : 'INVALID_OBJECT' }));
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host ?? '127.0.0.1', resolve); });
  return server;
}

export class HttpStorage {
  constructor(readonly baseUrl: string, private readonly token?: string) {}
  private objectUrl(uri: string): URL {
    const base = new URL(this.baseUrl); const url = new URL(uri);
    if (url.origin !== base.origin || !/^\/objects\/0x[0-9a-f]{64}$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error('STORAGE_URI_NOT_ALLOWED');
    return url;
  }
  async put(value: unknown): Promise<{ hash: Hex; uri: string }> {
    if (!this.token) throw new Error('Storage upload credential missing');
    const bytes = canonicalBytes(value); const hash = keccak256(bytes); const uri = new URL(`/objects/${hash}`, this.baseUrl).href;
    const response = await fetch(this.objectUrl(uri), { method: 'PUT', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: Buffer.from(bytes), redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Storage upload failed: ${response.status}`);
    await response.body?.cancel(); return { hash, uri };
  }
  async get(uri: string, expectedHash: Hex): Promise<unknown> {
    return parseJsonBytes(await this.getBytes(uri, expectedHash));
  }
  async getBytes(uri: string, expectedHash: Hex): Promise<Uint8Array> {
    const url = this.objectUrl(uri);
    if (!url.pathname.endsWith(expectedHash)) throw new Error('STORAGE_HASH_PATH_MISMATCH');
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok || !response.body) throw new Error(`Storage download failed: ${response.status}`);
    const bytes = await boundedBody(response.body);
    if (keccak256(bytes) !== expectedHash) throw new Error('STORAGE_INTEGRITY_FAILED');
    return bytes;
  }
}
