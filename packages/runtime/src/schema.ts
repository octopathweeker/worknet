import { Worker } from 'node:worker_threads';
export interface SchemaCheck { name: string; passed: boolean; detail: string; }
export async function checkOutputSchema(schema: unknown, output: unknown): Promise<SchemaCheck> {
  return new Promise(resolve => {
    const worker = new Worker(new URL('./schema-thread.js', import.meta.url), { workerData: { schema, output }, resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 } });
    let done = false;
    const finish = (passed: boolean, detail: string) => { if (done) return; done = true; clearTimeout(timer); void worker.terminate(); resolve({ name: 'output-schema', passed, detail }); };
    const timer = setTimeout(() => finish(false, 'schema time limit exceeded'), 1500);
    worker.once('message', (value: { valid: boolean; detail: string }) => finish(value.valid === true, value.detail));
    worker.once('error', () => finish(false, 'schema worker failed'));
    worker.once('exit', () => finish(false, 'schema worker exited'));
  });
}
