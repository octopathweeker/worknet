import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export type WorkerReport = { address: string; capability: string; accepting: boolean; updatedAt: string; phase: string; taskId?: string; recent: Array<{ at: string; event: string; taskId?: string }>; error?: string };
export async function workerAccepting(directory: string, address: string): Promise<boolean> {
  try { const data = JSON.parse(await readFile(path.join(directory, 'worker-controls.json'), 'utf8')); return data[address.toLowerCase()]?.accepting !== false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}
export async function setWorkerAccepting(directory: string, address: string, accepting: boolean) {
  const filename = path.join(directory, 'worker-controls.json');
  let controls: Record<string, unknown> = {};
  try { controls = JSON.parse(await readFile(filename, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  controls[address.toLowerCase()] = { accepting, updatedAt: new Date().toISOString() };
  await writeFile(filename + '.tmp', JSON.stringify(controls), { mode: 0o600 }); await rename(filename + '.tmp', filename);
}
export async function writeWorkerReport(directory: string, report: WorkerReport) {
  const dir = path.join(directory, 'workers'); await mkdir(dir, { recursive: true });
  const filename = path.join(dir, `${report.address.toLowerCase()}.json`);
  await writeFile(filename + '.tmp', JSON.stringify(report), { mode: 0o600 }); await rename(filename + '.tmp', filename);
}
