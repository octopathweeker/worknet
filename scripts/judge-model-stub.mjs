// Minimal local stand-in for the TypeSafe System One endpoint when no
// TYPESAFE_API_KEY is configured. Returns a fixed completion score.
import { createServer } from 'node:http';

const port = Number(process.env.STUB_PORT ?? 8790);
const score = Number(process.env.STUB_SCORE ?? 3);
const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.method === 'GET' && request.url === '/health') { response.end(JSON.stringify({ ok: true, score })); return; }
  if (request.method !== 'POST' || !request.url?.startsWith('/v1/systemone')) { response.writeHead(404).end('{}'); return; }
  const chunks = []; request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    if (process.env.STUB_FAIL_ONCE === '1' && !globalThis.failed) {
      globalThis.failed = true; response.writeHead(429).end('{}'); return;
    }
    response.end(JSON.stringify({ model: 'stub-jev', answers: { completion: { type: 'score', score, legend: {}, probabilities: {} } }, usage: { input_tokens: 0, output_tokens: 0 } }));
  });
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ event: 'judge-model-stub', port, score })));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
