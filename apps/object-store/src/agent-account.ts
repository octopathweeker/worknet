import {recoverAuthorizationAddress} from 'viem/utils';
import { z } from 'zod';
import { recoverMessageAddress, recoverTypedDataAddress,  type Address, type Hex } from 'viem';
import { agentEnrollmentMessage, agentSessionPermission, AGENT_SESSION_SECONDS, AGENT_SESSION_CALLS, permissionTypedData, delegatedImplementation, isSupportedDelegation, type Delegation } from '@agent-task/accounts';
import { platformBody, platformClient, platformConfig, platformRate } from './platform-api.js';
import { idSchema, serialize } from './platform-domain.js';
import type { ExecutorRow } from './taker-api.js';
import type { Env } from './index.js';

const address=z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v=>v.toLowerCase() as Address);
const hex32=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const signature=z.string().regex(/^0x[0-9a-fA-F]{130}$/);
export type AgentGrant={id:string;owner:Address;signer:Address;manager:Address;token:Address;chainId:10143;validUntil:number;maxCalls:number;permission:Delegation;authorization?:{address:Address;chainId:number;nonce:number;r:Hex;s:Hex;yParity:number};approved?:boolean};
export async function agentGrant(env:Env,id:string):Promise<AgentGrant|null>{const row=await env.DB!.prepare('SELECT body FROM platform_agent_grants WHERE id=?').bind(id).first<{body:string|null}>();return row?.body?JSON.parse(row.body):null;}
/** Account history stays readable after authorization ends; this never renews authority. */
export async function inspectAgent(env:Env,id:string,owner:Address){
  const row=await env.DB!.prepare('SELECT e.*,g.signer,g.body AS grant_body FROM platform_executors e JOIN platform_agent_grants g ON g.id=e.id WHERE e.id=?').bind(id).first<ExecutorRow&{signer:Address;grant_body:string|null}>();
  if(!row)throw new Error('NOT_FOUND');
  const grant:AgentGrant|null=row.grant_body?JSON.parse(row.grant_body):null;
  const boundOwner=row.owner??grant?.owner;
  if(boundOwner&&boundOwner!==owner)throw new Error('AGENT_ACCOUNT_MISMATCH');
  const state=row.revoked?'revoked':row.expires_at<=Date.now()?'expired':row.approved?'active':'pending';
  const newer=boundOwner?await env.DB!.prepare('SELECT e.id FROM platform_executors e JOIN platform_agent_grants g ON e.id=g.id WHERE e.owner=? AND g.signer=? AND e.id<>? AND e.created_at>? AND e.approved=1 AND e.revoked=0 AND e.expires_at>? ORDER BY e.created_at DESC LIMIT 1').bind(boundOwner,row.signer,id,row.created_at,Date.now()).first<{id:string}>():null;
  return {id:row.id,name:row.name,owner:boundOwner??null,signer:row.signer,expiresAt:row.expires_at,approved:Boolean(row.approved),state,grant,newerId:newer?.id??null};
}
export async function startAgent(request:Request,env:Env){
  await platformRate(env,`agent-start:${request.headers.get('cf-connecting-ip')??'local'}`,12,3600000);
  const input=z.object({id:idSchema,name:z.string().trim().min(1).max(80),tokenHash:hex32,signer:address,proof:signature}).strict().parse(await platformBody(request));
  const origin=new URL(request.url).origin;
  if((await recoverMessageAddress({message:agentEnrollmentMessage(origin,input.id,input.name,input.tokenHash as Hex),signature:input.proof as Hex})).toLowerCase()!==input.signer)throw new Error('SIGNATURE_INVALID');
  await env.DB!.prepare('INSERT OR IGNORE INTO platform_executors(id,token_hash,name,expires_at,created_at) VALUES (?,?,?,?,?)').bind(input.id,input.tokenHash,input.name,Date.now()+86400000,Date.now()).run();
  const executor=await env.DB!.prepare('SELECT * FROM platform_executors WHERE id=?').bind(input.id).first<ExecutorRow>();
  if(executor&&executor.expires_at<=Date.now())throw new Error('PAIR_EXPIRED');
  if(!executor||executor.token_hash!==input.tokenHash||executor.name!==input.name||executor.revoked)throw new Error('REQUEST_CONFLICT');
  await env.DB!.prepare('INSERT OR IGNORE INTO platform_agent_grants(id,signer) VALUES (?,?)').bind(input.id,input.signer).run();
  const row=await env.DB!.prepare('SELECT signer FROM platform_agent_grants WHERE id=?').bind(input.id).first<{signer:string}>();
  if(row?.signer!==input.signer)throw new Error('REQUEST_CONFLICT');
  return {id:input.id,signer:input.signer,approvalUrl:`${origin}/#/taker/executors/${input.id}`,expiresAt:executor.expires_at,approved:Boolean(executor.approved),instruction:'首次用 Mera Passkey 创建或选择收款账户，并确认 7 天、200 次领取/提交权限。之后 Agent 可自主工作。'};
}
export async function prepareAgent(env:Env,id:string,owner:Address){
  const row=await env.DB!.prepare('SELECT e.*,g.signer FROM platform_executors e JOIN platform_agent_grants g ON g.id=e.id WHERE e.id=?').bind(id).first<ExecutorRow&{signer:Address}>();
  if(!row||row.revoked||row.expires_at<=Date.now()||row.owner&&row.owner!==owner)throw new Error('PAIR_EXPIRED');
  const config=platformConfig(env),client=platformClient(config);
  const code=await client.getCode({address:owner});if(code&&code!=='0x'&&!isSupportedDelegation(code))throw new Error('WRONG_DELEGATION');
  let grant=await agentGrant(env,id);
  if(grant&&grant.owner!==owner)throw new Error('REQUEST_CONFLICT');
  if(!grant){
    const validUntil=Number((await client.getBlock({blockTag:'finalized'})).timestamp)+AGENT_SESSION_SECONDS;
    grant={id,owner,signer:row.signer,manager:config.manager,token:config.token,chainId:10143,validUntil,maxCalls:AGENT_SESSION_CALLS,permission:agentSessionPermission(owner,row.signer,config.manager,id,validUntil)};
    await env.DB!.prepare('UPDATE platform_agent_grants SET body=? WHERE id=? AND body IS NULL').bind(serialize(grant),id).run();
    grant=(await agentGrant(env,id))!;
    if(grant.owner!==owner)throw new Error('REQUEST_CONFLICT');
  }
  if(grant.validUntil*1000<=Date.now())throw new Error('GRANT_EXPIRED');
  return {...grant,typedData:permissionTypedData(grant.permission),implementation:delegatedImplementation,activationRequired:!isSupportedDelegation(code),nonce:await client.getTransactionCount({address:owner,blockTag:'pending'})};
}
export async function approveAgent(request:Request,env:Env,owner:Address){
  const input=z.object({id:idSchema,signature,authorization:z.object({address,chainId:z.literal(10143),nonce:z.number().int().nonnegative().safe(),r:hex32,s:hex32,yParity:z.union([z.literal(0),z.literal(1)])}).strict().optional()}).strict().parse(await platformBody(request));
  const grant=await prepareAgent(env,input.id,owner);
  if((await recoverTypedDataAddress({...permissionTypedData(grant.permission),signature:input.signature as Hex})).toLowerCase()!==owner)throw new Error('SIGNATURE_INVALID');
  if(grant.activationRequired){
    const auth=input.authorization;
    if(!auth||auth.address!==delegatedImplementation.toLowerCase()||auth.nonce!==grant.nonce||(await recoverAuthorizationAddress({authorization:auth as any})).toLowerCase()!==owner)throw new Error('AUTHORIZATION_INVALID');
  }
  const saved:AgentGrant={id:grant.id,owner,signer:grant.signer,manager:grant.manager,token:grant.token,chainId:10143,validUntil:grant.validUntil,maxCalls:grant.maxCalls,permission:{...grant.permission,signature:input.signature as Hex},approved:true,...(input.authorization?{authorization:input.authorization as NonNullable<AgentGrant['authorization']>}:{})};
  // Persist the public signed grant before approval. A crash remains recoverable by resubmitting.
  await env.DB!.prepare('UPDATE platform_agent_grants SET body=? WHERE id=?').bind(serialize(saved),input.id).run();
  const changed=await env.DB!.prepare('UPDATE platform_executors SET owner=?,approved=1,expires_at=? WHERE id=? AND revoked=0 AND (owner IS NULL OR owner=?) AND expires_at>? RETURNING id').bind(owner,saved.validUntil*1000,input.id,owner,Date.now()).first();
  if(!changed)throw new Error('PAIR_EXPIRED');
  return {approved:true,grant:saved};
}
