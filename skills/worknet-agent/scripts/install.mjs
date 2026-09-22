#!/usr/bin/env node
import {readFile,writeFile,mkdir,lstat,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('..',import.meta.url));
const [host='codex',...flags]=process.argv.slice(2);
const targetIndex=flags.indexOf('--target-dir');const target=targetIndex<0?undefined:flags[targetIndex+1];
if(targetIndex>=0)flags.splice(targetIndex,2);
if(!['codex','claude'].includes(host)||flags.some(flag=>flag!=='--update')||(targetIndex>=0&&(!target||!isAbsolute(target))))throw new Error('Usage: node scripts/install.mjs [codex|claude] [--update] [--target-dir ABSOLUTE_SKILL_DIRECTORY]');
if(Number(process.versions.node.split('.')[0])!==24)throw new Error('Use Node.js 24');
const base=host==='codex'?(process.env.CODEX_HOME??join(homedir(),'.codex')):join(homedir(),'.claude');
const destination=target??join(base,'skills','worknet-agent');
const files=['SKILL.md','agents/openai.yaml','platform.json','scripts/worknet-taker.mjs','scripts/worknet-taker.sha256','scripts/install.mjs'];
const bytes=await readFile(join(source,'scripts/worknet-taker.mjs'));
const checksum=(await readFile(join(source,'scripts/worknet-taker.sha256'),'utf8')).trim().split(/\s+/)[0];
if(createHash('sha256').update(bytes).digest('hex')!==checksum)throw new Error('Bundled CLI checksum mismatch');
let exists=false;try{const stat=await lstat(destination);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Skill destination must be a regular directory');exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
if(exists){let marker;try{marker=JSON.parse(await readFile(join(destination,'.worknet-skill.json'),'utf8'));}catch{}if(marker?.managedBy!=='worknet-agent-installer'||!flags.includes('--update'))throw new Error('Destination exists. Only an installer-managed skill can be updated with --update.');}
// Validate the entire source and destination before changing files.
for(const file of files){const stat=await lstat(join(source,file));if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Unexpected package entry');for(const relative of [dirname(file),file]){if(relative==='.')continue;try{if((await lstat(join(destination,relative))).isSymbolicLink())throw new Error('Refusing destination symlink');}catch(error){if(error.code!=='ENOENT')throw error;}}}
await mkdir(destination,{recursive:true});
for(const file of files){const target=join(destination,file);await mkdir(dirname(target),{recursive:true});await writeFile(target,await readFile(join(source,file)),{mode:0o644});}
await chmod(join(destination,'scripts/worknet-taker.mjs'),0o755);
await writeFile(join(destination,'.worknet-skill.json'),JSON.stringify({managedBy:'worknet-agent-installer',cliSha256:checksum})+'\n');
const platform=JSON.parse(await readFile(join(destination,'platform.json'),'utf8'));
console.log(JSON.stringify({installed:destination,skill:'worknet-agent',platform,reloadSkillDiscovery:true,mcp:{command:process.execPath,args:[join(destination,'scripts/worknet-taker.mjs'),'mcp']}},null,2));
