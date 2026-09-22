import { z } from 'zod';

export const intentSchema = z.object({
  version: z.literal('worknet-intent/1'),
  objective: z.string().trim().min(1).max(2000),
  constraints: z.array(z.string().trim().min(1).max(300)).max(8),
  assumptions: z.array(z.string().trim().min(1).max(300)).max(8),
  evidenceRequirements: z.array(z.string().trim().min(1).max(300)).max(8),
}).strict();

// URLs are references supplied by the agent, never instructions for a server-side fetch.
export const publicReference = z.string().url().max(512).refine(value => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
}, 'Use an HTTP(S) reference without credentials.');
export const generalOutput = z.object({
  format: z.literal('markdown'),
  content: z.string().trim().min(1).max(20000),
  sources: z.array(z.object({ title: z.string().trim().min(1).max(200), url: publicReference }).strict()).max(16),
}).strict();
export const generalOutputSchema = {
  type: 'object', additionalProperties: false, required: ['format', 'content', 'sources'],
  properties: {
    format: { const: 'markdown' }, content: { type: 'string', minLength: 1, maxLength: 20000 },
    sources: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['title', 'url'], properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, url: { type: 'string', maxLength: 512, pattern: '^https?://' } } } },
  },
};
