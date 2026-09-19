import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
execFileSync(process.execPath, ['scripts/check-release.mjs'], { stdio: 'inherit' });
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim()) throw new Error('Commit the reviewed source before creating its archive.');
mkdirSync('.runtime/release', { recursive: true });
const output = '.runtime/release/worknet-source.tar.gz';
execFileSync('git', ['archive', '--format=tar.gz', '--prefix=worknet/', `--output=${output}`, 'HEAD']);
console.log(JSON.stringify({ output, sha256: createHash('sha256').update(readFileSync(output)).digest('hex') }));
