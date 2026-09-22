import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = path.join(root, 'apps/explorer/dist/downloads');
await mkdir(directory, { recursive: true });
const outfile = `${directory}/worknet-taker.mjs`;
await build({ absWorkingDir: root, entryPoints: ['packages/taker/src/cli.ts'], outfile, bundle: true, platform: 'node', target: 'node24', format: 'esm', minify: true, sourcemap: false, banner: { js: 'import { createRequire as __worknetCreateRequire } from "node:module"; const require = __worknetCreateRequire(import.meta.url);' }, logLevel: 'warning' });
const bytes = await readFile(outfile);
await writeFile(`${directory}/worknet-taker.sha256`, `${createHash('sha256').update(bytes).digest('hex')}  worknet-taker.mjs\n`);
// Repository installs copy this folder without running a build. Keep its runtime complete.
await mkdir(path.join(root,'skills/worknet-agent/scripts'),{recursive:true});
await copyFile(outfile,path.join(root,'skills/worknet-agent/scripts/worknet-taker.mjs'));
await copyFile(`${directory}/worknet-taker.sha256`,path.join(root,'skills/worknet-agent/scripts/worknet-taker.sha256'));
await copyFile(path.join(root, 'docs/TAKER.md'), `${directory}/taker-guide.md`);
await copyFile(path.join(root, 'docs/MARKET.md'), `${directory}/market-guide.md`);
console.log(`Standalone taker CLI/MCP: ${bytes.length} bytes; guide and SHA-256 written.`);

const staging = await mkdtemp(path.join(tmpdir(), 'worknet-skill-'));
try {
  const skill = path.join(staging,'worknet-agent');
  for (const file of ['SKILL.md','agents/openai.yaml','platform.json','scripts/install.mjs']) {
    await mkdir(path.dirname(path.join(skill,file)),{recursive:true});
    await copyFile(path.join(root,'skills/worknet-agent',file),path.join(skill,file));
  }
  let origin = process.env.WORKNET_PUBLIC_ORIGIN;
  if (!origin) { try { const config=JSON.parse(await readFile(path.join(root,'.runtime/m6/wrangler.jsonc'),'utf8')); if(config.vars?.WORKNET_ENVIRONMENT==='production') origin=config.vars.WORKNET_PUBLIC_ORIGIN; } catch(error) { if(error.code!=='ENOENT')throw error; } }
  if(origin){const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password)throw new Error('Invalid public Skill origin');await writeFile(path.join(skill,'platform.json'),JSON.stringify({origin,chainId:10143})+'\n');}
  await copyFile(outfile,path.join(skill,'scripts/worknet-taker.mjs'));
  await copyFile(`${directory}/worknet-taker.sha256`,path.join(skill,'scripts/worknet-taker.sha256'));
  const archive=path.join(directory,'worknet-agent-skill.tar.gz');
  execFileSync('tar',['-czf',archive,'-C',staging,'worknet-agent'],{env:{...process.env,COPYFILE_DISABLE:'1'}});
  const archiveBytes=await readFile(archive);
  await writeFile(`${archive}.sha256`,`${createHash('sha256').update(archiveBytes).digest('hex')}  worknet-agent-skill.tar.gz\n`);
  console.log(`Installable Worknet Agent Skill: ${archiveBytes.length} bytes; CLI/MCP included.`);
} finally { await rm(staging,{recursive:true,force:true}); }
