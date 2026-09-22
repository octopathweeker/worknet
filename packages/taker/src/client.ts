import { setTimeout as sleep } from 'node:timers/promises';
import { createPublicClient, http, type Address } from 'viem';
import { monadTestnet } from 'viem/chains';
import { taskManagerAbi } from '@agent-task/contracts';
import { hashJson, validateTaskSpec, assertTaskSpecBinding } from '@agent-task/protocol';
import { transferHandler } from '@agent-task/runtime';

export function platformUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('Use an HTTPS platform origin, or loopback for local tests.');
  return url.origin;
}
export type Assignment = {
  id: string; taskId: string; attempt: string; version: string; mode: string; capability: string;
  validUntil: number; resultHash: string | null; taskStatus: number | null; taskAttempt: string | null;
  worker: string | null; lease: string | null; claimStatus: string | null; submitStatus: string | null;
};
export type AssignmentBatch = { cursor: string; timedOut: boolean; runs: Assignment[] };
export class TakerApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(`${status} ${code}: ${message}`); }
}
export class TakerClient {
  readonly origin: string;
  constructor(origin: string, private readonly token?: string, readonly signal?: AbortSignal, private readonly onWork?: () => Promise<void>) { this.origin = platformUrl(origin); if (token && !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid executor credential'); }
  async request(path: string, body?: unknown, query?: URLSearchParams, timeoutMs = 45000): Promise<any> {
    if (!/^\/[a-z0-9/-]+$/.test(path)) throw new Error('Invalid API path');
    const response = await fetch(`${this.origin}/platform/taker${path}${query?.size ? `?${query}` : ''}`, { method: body === undefined ? 'GET' : 'POST', redirect:'error', signal:AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(this.signal ? [this.signal] : [])]), headers: { 'content-type':'application/json', ...(this.token ? {authorization:`Bearer ${this.token}`} : {}) }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
    const reader=response.body?.getReader();if(!reader)throw new Error('Empty API response');let text='',size=0;const decoder=new TextDecoder();
    try { while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2*1024*1024){await reader.cancel();throw new Error('API response too large');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode(); } finally {reader.releaseLock();}
    const value=JSON.parse(text);if(!response.ok)throw new TakerApiError(response.status, value.code??'API_ERROR', value.error??'Request failed');return value;
  }
  protected async recordWork(){
    try { await this.onWork?.(); }
    catch { console.warn('Could not remember the last task account. Keep using the same WORKNET_TAKER_CONFIG.'); }
  }
  status(){return this.request('/me');}
  take(taskId:string){if(!/^[1-9][0-9]{0,76}$/.test(taskId))throw new Error('A task number is required');return this.request('/agent/take',{taskId});}
  tasks(){return this.request('/tasks');}
  runs(){return this.request('/runs');}
  wait(cursor?: string): Promise<AssignmentBatch> {
    if (cursor !== undefined && !/^0x[0-9a-f]{64}$/.test(cursor)) throw new Error('Invalid wait cursor');
    return this.request('/runs/wait', undefined, new URLSearchParams(cursor ? {cursor} : {}));
  }
  run(id:string){return this.request(`/runs/${id}`);}
  claim(id:string){return this.request(`/runs/${id}/claim`,{});}
  async upload(id:string,execution:unknown){const result=await this.request(`/runs/${id}/result`,execution);await this.recordWork();return result;}
  /** Off-chain, requester-visible report. Reuse update.id and content on retries. */
  async progress(id:string,update:{id:string;summary:string;percent?:number}){const result=await this.request(`/runs/${id}/progress`,update,undefined,5000);await this.recordWork();return result;}
  submit(id:string){return this.request(`/runs/${id}/submit`,{});}
  /** May spend the platform's bounded tool budget. Input and provider are fixed by the server. */
  purchaseTransfers(id:string){return this.request(`/runs/${id}/tools/transfers`,{});}
  async waitClaim(id:string){for(let i=0;i<45;i++){const run=await this.run(id);if(Number(run.task.status)===1&&run.task.worker.toLowerCase()===run.owner&&String(run.task.attempt)===run.attempt){await this.recordWork();return run;}if(Number(run.task.status)>=2) return run;if(run.revoked||run.superseded||!run.authorized)throw new Error('Run no longer active');await sleep(2000,undefined,this.signal?{signal:this.signal}:{});}throw new Error('Claim is still pending; resume the same run.');}
  /** Pure execution capability: no signer or credential is passed to the handler. */
  async analyze(id:string) {
    const run=await this.run(id);const spec=validateTaskSpec(run.spec);
    if(spec.capability!=='analysis.token-transfers')throw new Error('Use your harness for this capability and upload its execution JSON.');
    const response=await fetch(`${this.origin}/platform/config`,{redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(20000), ...(this.signal ? [this.signal] : [])])});if(!response.ok)throw new Error('Config unavailable');const config=await response.json() as any;
    const rpc=new URL(config.rpcWalletUrl);if(rpc.protocol!=='https:'&&!(rpc.protocol==='http:'&&['localhost','127.0.0.1'].includes(rpc.hostname)))throw new Error('Invalid public RPC');
    const client=createPublicClient({chain:monadTestnet,transport:http(rpc.href,{timeout:15000,retryCount:1})});if(await client.getChainId()!==10143)throw new Error('Wrong chain');
    const task=await client.readContract({address:config.manager as Address,abi:taskManagerAbi,functionName:'getTask',args:[BigInt(run.taskId)],blockTag:'finalized'});
    if(task.status!==1||task.worker.toLowerCase()!==run.owner||String(task.attempt)!==run.attempt||hashJson(spec)!==task.specHash)throw new Error('Claim or specification changed');
    assertTaskSpecBinding(spec,{settlementChainId:'10143',taskManager:config.manager.toLowerCase(),requester:task.requester.toLowerCase(),clientRequestId:spec.clientRequestId,settlementToken:config.token.toLowerCase(),params:task});
    const head=await client.getBlock({blockTag:'finalized'});if(BigInt((spec.input as any).toBlock)>head.number)throw new Error('Unfinalized range');
    const duration=Number(task.claimLeaseExpiresAt-head.timestamp)-20;if(duration<=0)throw new Error('Lease nearly expired');
    return transferHandler.execute(spec,{client,chainId:10143,signal:AbortSignal.any([AbortSignal.timeout(Math.min(duration*1000,180000)), ...(this.signal ? [this.signal] : [])])});
  }
}
