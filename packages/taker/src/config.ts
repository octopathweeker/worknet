import {existsSync} from 'node:fs';
import {readFile,writeFile,mkdir,chmod,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {selectConfigPath,rememberAccount,lastAccountPath} from './account-selection.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {agentEnrollmentMessage} from '@agent-task/accounts';
import {keccak256,stringToHex,type Hex} from 'viem';
import {TakerClient,TakerApiError,platformUrl} from './client.js';
export type LocalConfig={origin:string;token:string;id:string;name:string;executionKey?:Hex};
// Pin an implicit selection for this process (including a long-running MCP server).
let implicitConfigPath:string|undefined;
export const configPath=()=>process.env.WORKNET_TAKER_CONFIG!==undefined?selectConfigPath(process.env.WORKNET_TAKER_CONFIG):implicitConfigPath??=selectConfigPath(undefined);
export async function loadConfig():Promise<LocalConfig>{
 try{return JSON.parse(await readFile(configPath(),'utf8'));}
 catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT'&&process.env.WORKNET_TAKER_CONFIG===undefined&&existsSync(lastAccountPath()))throw new Error('LAST_ACCOUNT_UNAVAILABLE: restore the previous account config or explicitly select WORKNET_TAKER_CONFIG.');
  throw error;
 }
}
export async function saveConfig(value:LocalConfig){const path=configPath();await mkdir(dirname(path),{recursive:true,mode:0o700});const temporary=`${path}.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,path);await chmod(path,0o600);}
export async function pair(origin:string,name:string){let config:LocalConfig;try{config=await loadConfig();if(config.origin!==platformUrl(origin)||config.name!==name)throw new Error('An executor is already stored at this config path. Use a different WORKNET_TAKER_CONFIG for another executor.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;config={origin:platformUrl(origin),token:randomBytes(32).toString('hex'),id:randomUUID(),name};await saveConfig(config);}
 const result=await new TakerClient(config.origin).request('/pair',{id:config.id,name:config.name,tokenHash:keccak256(stringToHex(config.token))});return {...result,configPath:configPath()};}
export async function configuredClient(signal?:AbortSignal):Promise<TakerClient>{
 const path=configPath(),config=await loadConfig();
 const onWork=()=>rememberAccount({configPath:path,origin:config.origin,executorId:config.id,name:config.name});
 if(config.executionKey){const {AgentClient}=await import('./agent.js');return new AgentClient(config.origin,config.token,config.executionKey,config.id,path,signal,onWork);}
 return new TakerClient(config.origin,config.token,signal,onWork);
}
export async function initializeAgent(origin:string,name:string){const {withAgentLock}=await import('./agent.js');return withAgentLock(configPath(),()=>initializeAgentUnlocked(origin,name));}
async function initializeAgentUnlocked(origin:string,name:string){
 let config:LocalConfig;try{config=await loadConfig();if(!config.executionKey||config.origin!==platformUrl(origin)||config.name!==name)throw new Error('Use a new WORKNET_TAKER_CONFIG for this Agent; the existing account is preserved.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;config={origin:platformUrl(origin),token:randomBytes(32).toString('hex'),id:randomUUID(),name,executionKey:generatePrivateKey()};await saveConfig(config);}
 const account=privateKeyToAccount(config.executionKey!),tokenHash=keccak256(stringToHex(config.token));
 return {...await new TakerClient(config.origin).request('/agent/start',{id:config.id,name:config.name,tokenHash,signer:account.address,proof:await account.signMessage({message:agentEnrollmentMessage(config.origin,config.id,config.name,tokenHash)})}),configPath:configPath()};
}

/** Explicit renewal keeps the execution key and gas address; every new grant needs the human. */
export async function renewAgent(){
 const {withAgentLock}=await import('./agent.js');
 return withAgentLock(configPath(),async()=>{
  const config=await loadConfig();if(!config.executionKey)throw new Error('Legacy pairing has no Agent execution key; use init with a separate config.');
  try{
   const enrollment=await initializeAgentUnlocked(config.origin,config.name);
   if(!enrollment.approved)return enrollment; // A pending renewal always resumes the same ID.
   const current=await (await configuredClient()).status();
   if(!current.chainRevoked&&current.remainingCalls>=2)throw new Error('The current authorization is still active. Continue using it; renewal is for expiry, revocation or exhausted call allowance.');
  }catch(error){if(!(error instanceof TakerApiError&&['UNAUTHORIZED','PAIR_EXPIRED','REQUEST_CONFLICT'].includes(error.code)))throw error;}
  // Keep the previous token and run ownership available for explicit recovery, never overwrite it.
  const archive=`${configPath()}.retired-${config.id}.json`;
  try{await writeFile(archive,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  await saveConfig({...config,id:randomUUID(),token:randomBytes(32).toString('hex')});
  return initializeAgentUnlocked(config.origin,config.name);
 });
}
