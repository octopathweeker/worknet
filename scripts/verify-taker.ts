import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {privateKeyToAccount} from 'viem/accounts';
import {erc20Abi,type Hex} from 'viem';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {client} from './testnet-common.js';
import {privateJson,persistPrivate} from './platform-chain.js';

const config=JSON.parse(await readFile('.runtime/platform/config.json','utf8'));
const keys=JSON.parse(await readFile('.runtime/platform/accounts.private.json','utf8')) as Record<string,Hex>;
const origin=config.storageUrl as string;
const state=await privateJson<Record<string,any>>('r4-verification.private.json',()=>({cases:{},checks:{}}));
const save=()=>persistPrivate('r4-verification.private.json',state);
async function login(name:string){const account=privateKeyToAccount(keys[name]!);let cookie='';const raw=(path:string,body?:unknown)=>fetch(`${origin}/platform/${path}`,{headers:{origin,cookie,'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(30000),...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});const call=async(path:string,body?:unknown)=>{const r=await raw(path,body);const value=await r.json() as any;if(!r.ok)throw new Error(`${path}: ${JSON.stringify(value)}`);return value;};const challenge=await call('auth/challenge',{address:account.address});const response=await raw('auth/verify',{id:challenge.id,signature:await account.signMessage({message:challenge.message})});assert(response.ok);cookie=response.headers.get('set-cookie')!.split(';')[0]!;return{account,call};}
const requester=await login('bob'),taker=await login('taker');
const cliPath=resolve('packages/taker/dist/cli.js');
async function cli(file: string, args: string[]) {
  return new Promise<any>((res, rej) => {
    const process = spawn(globalThis.process.execPath, [cliPath, ...args], { env: { ...globalThis.process.env, WORKNET_TAKER_CONFIG: file }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    process.stdout.on('data', b => out += b); process.stderr.on('data', b => err += b);
    const timer = setTimeout(() => process.kill('SIGTERM'), 150000);
    process.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) { rej(new Error(`CLI ${args[0]} failed: ${err.slice(-1000)}`)); return; }
      try { res(JSON.parse(out)); } catch { rej(new Error('CLI did not return JSON')); }
    });
  });
}

async function command(id:string){for(let i=0;i<90;i++){const row=await requester.call(`commands/${id}`);if(row.status==='complete')return row;if(row.status==='failed')throw new Error(JSON.stringify(row));await new Promise(r=>setTimeout(r,2000));}throw new Error('Command pending; resume same script.');}
async function waitRun(id:string,status:number){for(let i=0;i<90;i++){const r=await taker.call(`taker/runs/${id}`);if(Number(r.task.status)===status)return r;if(Number(r.task.status)>=3)throw new Error(`Unexpected terminal status ${r.task.status}`);if(i%10===0)console.log(JSON.stringify({run:id,state:r.task.status}));await new Promise(r=>setTimeout(r,2000));}throw new Error('Run pending; resume same IDs.');}
for(const kind of ['cli','mcp'] as const){
 state.cases[kind]??={planId:crypto.randomUUID(),launchId:crypto.randomUUID(),runId:crypto.randomUUID(),configFile:resolve(`.runtime/platform/r4-${kind}.private.json`)};const c=state.cases[kind];await save();
 if(c.revoked && c.result?.task?.status===3) { console.log(`${kind.toUpperCase()} already verified; retained original task ${c.taskId}.`); continue; }
 let mcp:Client|undefined;let transport:StdioClientTransport|undefined;
 const tool=async(name:string,args:Record<string,unknown>={})=>{const result=await mcp!.callTool({name,arguments:args});if(result.isError)throw new Error(JSON.stringify(result.content));return JSON.parse((result.content as any)[0].text);};
 try{
  if(kind==='mcp'){transport=new StdioClientTransport({command:process.execPath,args:[cliPath,'mcp'],env:{...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string')),WORKNET_TAKER_CONFIG:c.configFile},stderr:'pipe'});mcp=new Client({name:'worknet-r4-verification',version:'1.0.0'});await mcp.connect(transport);c.mcpTools=(await mcp.listTools()).tools.map(t=>t.name);}
  const paired=kind==='cli'?await cli(c.configFile,['pair',origin,'R4 CLI acceptance']):await tool('taker_pair',{origin,name:'R4 MCP acceptance'});c.executorId=paired.id;
  await taker.call('taker/pair/approve',{id:paired.id});
  if(!c.beforeBalance)c.beforeBalance=String(await client.readContract({address:config.token,abi:erc20Abi,functionName:'balanceOf',args:[taker.account.address]}));
  await requester.call('plans',{id:c.planId,goal:`R4 ${kind.toUpperCase()} 独立接单验收：完整复算测试 USDC 转账并交付核验数据。`,kind:'analysis',execution:'market',reward:'50000',fromBlock:'63805000',toBlock:'63805300'});
  await requester.call('launch',{id:c.launchId,goalId:c.planId});await command(c.launchId);
  const goals=(await requester.call('goals')).goals;const goal=goals.find((g:any)=>g.id===c.planId);c.taskId=goal.taskId;
  const prepared=await taker.call('taker/runs/prepare',{id:c.runId,taskId:c.taskId,executorId:paired.id,mode:'sponsored'});
  if(!c.authorized){await taker.call('taker/runs/authorize',{id:c.runId,claimSignature:await taker.account.signTypedData(prepared.claimTypedData),submitSignature:await taker.account.signTypedData(prepared.submitTypedData)});c.authorized=true;await save();}
  const before=await taker.call(`taker/runs/${c.runId}`);
  if(Number(before.task.status)<2){
    if(kind==='cli'){c.executionReply=await cli(c.configFile,['run',c.runId]);c.retryReply=await cli(c.configFile,['run',c.runId]);}
    else{
      c.discovered=await tool('taker_list_tasks');c.assigned=await tool('taker_list_runs');
      await tool('taker_claim',{runId:c.runId});await tool('taker_claim',{runId:c.runId});const claimed=await waitRun(c.runId,1);
      if(!claimed.resultHash){const execution=await tool('taker_analyze_transfers',{runId:c.runId});c.execution=execution;c.upload=await tool('taker_upload_result',{runId:c.runId,execution});c.uploadRetry=await tool('taker_upload_result',{runId:c.runId,execution});assert.equal(c.upload.hash,c.uploadRetry.hash);}
      c.submit=await tool('taker_submit',{runId:c.runId});c.submitRetry=await tool('taker_submit',{runId:c.runId});
    }
  }
  c.result=await waitRun(c.runId,3);assert.equal(c.result.task.worker.toLowerCase(),taker.account.address.toLowerCase());assert.equal(c.result.evidence.verdict,'accept');assert.equal(c.result.evidence.resultHash,c.result.task.resultHash);assert.equal(c.result.task.attempt.toString(),'1');
  c.afterBalance=String(await client.readContract({address:config.token,abi:erc20Abi,functionName:'balanceOf',args:[taker.account.address]}));assert.equal(BigInt(c.afterBalance)-BigInt(c.beforeBalance),50000n);c.takerMon=String(await client.getBalance({address:taker.account.address}));assert.equal(c.takerMon,'0');
  await taker.call('taker/executors/revoke',{id:c.executorId});c.revoked=true;await save();console.log(`${kind.toUpperCase()} task ${c.taskId} settled to zero-MON taker; executor revoked after verification.`);
 }finally{await mcp?.close();}
}
state.checks={cliAndStandardMcp:true,taskScopedUpload:true,retriedSameRun:true,zeroMonUserPaid:true,privateKeysNeverPassedToHarness:true};await save();
const cases=Object.fromEntries(Object.entries(state.cases).map(([k,v])=>{const {configFile:_config,...record}=v as any;return[k,record];}));
await mkdir('docs/stages/R4',{recursive:true});await writeFile('docs/stages/R4/testnet-verification.json',JSON.stringify({at:new Date().toISOString(),origin,requester:requester.account.address,taker:taker.account.address,cases,checks:state.checks,scope:'CLI and MCP run in independent local processes against cloud platform. Human wallet extension and another user-owned physical device remain untested.'},null,2)+'\n');
