import { parseJsonStrict } from '@agent-task/protocol';
import { boundedBody } from './storage.js';

export interface Model { model: string; json(system: string, input: unknown, signal: AbortSignal): Promise<unknown>; }
export function configuredModel(env: NodeJS.ProcessEnv = process.env): Model | undefined {
  if (!env.LLM_BASE_URL && !env.LLM_API_KEY && !env.LLM_MODEL) return undefined;
  if (!env.LLM_BASE_URL || !env.LLM_MODEL || !env.LLM_API_KEY) throw new Error('Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL together');
  return new ChatModel(env.LLM_BASE_URL, env.LLM_API_KEY, env.LLM_MODEL, Number(env.LLM_TIMEOUT_MS ?? 45000));
}
export class ChatModel implements Model {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, readonly model: string, private readonly timeoutMs = 45000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('LLM_TIMEOUT_MS must be 1000–120000');
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Invalid model endpoint');
  }
  async json(system: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, temperature: 0, max_tokens: 2048, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }] }),
    });
    if (!response.ok || !response.body) throw new Error(`MODEL_HTTP_${response.status}`);
    const data = parseJsonStrict(new TextDecoder().decode(await boundedBody(response.body))) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('MODEL_RESPONSE_INVALID');
    return parseJsonStrict(content);
  }
}
