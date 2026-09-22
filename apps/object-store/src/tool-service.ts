import { mppService } from './mpp-service.js';
import type { Env } from './index.js';

/** Separate service deployment: no user sessions, task signing keys or model gateway. */
export default {
  async fetch(request: Request, env: Env & { EXECUTOR_AGENT_CARD?: string }) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/health') {
      return Response.json({ service: 'worknet-transfer-tool', ready: Boolean(env.DB && env.PLATFORM_CONFIG && env.MPP_SERVICE_CONFIG && env.MPP_SERVICE_SECRET) });
    }
    if (request.method === 'GET' && path === '/services/executor.json' && env.EXECUTOR_AGENT_CARD) {
      return new Response(env.EXECUTOR_AGENT_CARD, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    }
    if (path === '/services/transfers' || path === '/services/agent.json') return mppService(request, env);
    return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  },
};
