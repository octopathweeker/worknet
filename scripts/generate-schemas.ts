import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { taskSpecSchema, resultManifestSchema } from '../packages/protocol/src/schemas.js';

const directory = new URL('../packages/protocol/schemas/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const [name, schema] of Object.entries({ 'task-spec': taskSpecSchema, 'result-manifest': resultManifestSchema })) {
  const file = new URL(`${name}.schema.json`, directory);
  const text = JSON.stringify(schema, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(file, 'utf8') !== text) throw new Error(`Schema drift: ${name}`);
  } else await writeFile(file, text);
}
console.log(`Protocol schemas ${process.argv.includes('--check') ? 'checked' : 'generated'}`);
