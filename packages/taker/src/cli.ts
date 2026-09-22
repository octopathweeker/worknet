#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {executeRun,watchAssignments} from './watch.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {pair,initializeAgent,renewAgent,configuredClient,configPath} from './config.js';
import {createTakerMcp} from './mcp.js';
const [command,...args]=process.argv.slice(2);
const print=(v:unknown)=>console.log(JSON.stringify(v,null,2));
const id=()=>{if(!/^[0-9a-f-]{36}$/.test(args[0]??''))throw new Error('A run UUID is required');return args[0]!;};
try {
 if(command==='mcp'){await createTakerMcp().connect(new StdioServerTransport());}
 else if(command==='init'){if(!args[0])throw new Error('init <platform-origin> [agent-name]');print(await initializeAgent(args[0],args[1]??'Worknet Agent'));}
 else if(command==='renew'){print(await renewAgent());}
 else if(command==='take'){if(!args[0])throw new Error('take <task-id>');print(await (await configuredClient()).take(args[0]));}
 else if(command==='pair'){if(!args[0])throw new Error('pair <platform-origin> [executor-name]');print(await pair(args[0],args[1]??'Worknet CLI'));}
 else if(command==='status'){print(await (await configuredClient()).status());}
 else if(command==='tasks'){print(await (await configuredClient()).tasks());}
 else if(command==='runs'){print(await (await configuredClient()).runs());}
 else if(command==='get'){print(await (await configuredClient()).run(id()));}
 else if(command==='claim'){print(await (await configuredClient()).claim(id()));}
 else if(command==='progress'){
  if(!args[1]||!args[2])throw new Error('progress <run-id> <update-uuid> <summary> [percent]');
  const percent=args[3]===undefined?undefined:Number(args[3]);
  if(percent!==undefined&&(!Number.isInteger(percent)||percent<0||percent>100))throw new Error('Percent must be an integer from 0 to 100');
  print(await (await configuredClient()).progress(id(),{id:args[1],summary:args[2],...(percent===undefined?{}:{percent})}));
 }
 else if(command==='submit'){print(await (await configuredClient()).submit(id()));}
 else if(command==='tool'){print(await (await configuredClient()).purchaseTransfers(id()));}
 else if(command==='upload'){if(!args[1])throw new Error('upload <run-id> <execution.json>');const bytes=await readFile(args[1]);if(bytes.length>64000)throw new Error('Execution exceeds upload limit');print(await (await configuredClient()).upload(id(),JSON.parse(bytes.toString())));}
 else if(command==='wait'){print(await (await configuredClient()).wait(args[0]));}
 else if(command==='watch'){
  const controller=new AbortController();
  const stop=()=>controller.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
   const client=await configuredClient(controller.signal);
   await watchAssignments({wait:cursor=>client.wait(cursor),execute:runId=>executeRun(client,runId,dirname(configPath()),{paidTools:args.includes('--paid-tool')}),signal:controller.signal,log:print});
  } finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
 }
 else if(command==='run'){const result=await executeRun(await configuredClient(),id(),dirname(configPath()),{paidTools:args.includes('--paid-tool')});print(result.detail??result);}
 else {console.log('worknet-taker init <origin> [name] | renew | take <task-id> | pair <origin> [name] | status | tasks | runs | wait [cursor] | watch [--paid-tool] | get <run> | claim <run> | run <run> [--paid-tool] | tool <run> | progress <run> <update-uuid> <summary> [percent] | upload <run> <execution.json> | submit <run> | mcp\n--paid-tool and tool may spend the platform tool budget within its configured limits. Default analysis stays local and read-only.\nWORKNET_TAKER_CONFIG selects a private local credential file. Agent mode stores a restricted local execution key; the Mera account key remains with the Passkey.');}
}catch(e){console.error(String(e));process.exitCode=1;}
