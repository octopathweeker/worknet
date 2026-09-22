import type { DurableObjectState, DurableObjectNamespace } from '@cloudflare/workers-types';
import { createPublicClient, http, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { taskManagerAbi } from '@agent-task/contracts';
import { parseJsonStrict } from '@agent-task/protocol/json';
import { generalOutput, intentSchema, scoreCompletion, judgeOutput, validateBinding, verdictTypedData, type JudgeRequest, type JudgeVerdict } from '@agent-task/judging';
import { z } from 'zod';

export interface JudgeEnv { EVALUATIONS: DurableObjectNamespace; JUDGE_CONFIG: string; JUDGE_PRIVATE_KEY: Hex; JUDGE_SERVICE_TOKEN: string; OPENROUTER_API_KEY?: string; MODEL_GATEWAY?: { fetch(request: Request): Promise<Response> }; MODEL_GATEWAY_TOKEN?: string; JUDGE_ID: string; JEV_MODEL?: string; }
const json = (value: unknown, status=200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
async function bounded(request: Request, limit=512000) {
  if (!request.body) throw new Error('INVALID_BODY');
  const reader=request.body.getReader(); const decoder=new TextDecoder('utf-8',{fatal:true}); let value=''; let size=0;
  try { while(true) { const {done,value:bytes}=await reader.read(); if(done) break; size+=bytes.length; if(size>limit){await reader.cancel();throw new Error('BODY_LIMIT');} value+=decoder.decode(bytes,{stream:true}); } return value+decoder.decode(); }
  finally {reader.releaseLock();}
}
async function authenticated(request: Request, token: string | undefined) {
  if (!token || token.length < 32) return false;
  const actual=request.headers.get('authorization')??'';
  if(actual.length>512) return false;
  const enc=new TextEncoder(); const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',enc.encode(actual)),crypto.subtle.digest('SHA-256',enc.encode(`Bearer ${token}`))]);
  let diff=0;new Uint8Array(a).forEach((v,i)=>{diff|=v^new Uint8Array(b)[i]!;});return diff===0;
}
function configuration(env: JudgeEnv) {
  const c=z.object({chainId:z.literal(10143),manager:z.string().regex(/^0x[0-9a-fA-F]{40}$/),rpcUrl:z.string().url()}).parse(JSON.parse(env.JUDGE_CONFIG));
  if(new URL(c.rpcUrl).protocol!=='https:')throw new Error('RPC_HTTPS_REQUIRED');
  return {...c,manager:c.manager as Address};
}
export default {
  async fetch(request: Request, env: JudgeEnv) {
    const url=new URL(request.url);
    if(url.pathname==='/health' && request.method==='GET') return json({service:'worknet-judge',ready:Boolean(env.JUDGE_CONFIG&&env.JUDGE_PRIVATE_KEY&&(env.OPENROUTER_API_KEY || env.MODEL_GATEWAY && env.MODEL_GATEWAY_TOKEN)&&env.JUDGE_SERVICE_TOKEN),judgeId:env.JUDGE_ID});
    if(url.pathname!=='/evaluate'||request.method!=='POST')return json({error:'NOT_FOUND'},404);
    if(!await authenticated(request,env.JUDGE_SERVICE_TOKEN))return json({error:'UNAUTHORIZED'},401);
    try {
      const payload=parseJsonStrict(await bounded(request)) as JudgeRequest;const c=configuration(env);validateBinding(payload,c.chainId,c.manager);
      const id=env.EVALUATIONS.idFromName(`${c.chainId}:${c.manager.toLowerCase()}:${payload.taskId}:${payload.attempt}:${payload.resultHash}`);
      const response=await env.EVALUATIONS.get(id).fetch('https://judge/evaluate',{method:'POST',body:JSON.stringify(payload)});
      return new Response(await response.arrayBuffer(),{status:response.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
    } catch {return json({error:'EVALUATION_PAYLOAD_INVALID'},422);}
  },
};

/** Each deployment owns its signing key and durable vote cache. Retries never redraw a score. */
export class JudgeEvaluation {
  private inFlight?: Promise<Response>;
  constructor(private readonly ctx: DurableObjectState, private readonly env: JudgeEnv) {}
  async fetch(request: Request) {
    if(this.inFlight) return (await this.inFlight).clone();
    this.inFlight=this.evaluate(request);
    try{return (await this.inFlight).clone();}finally{delete this.inFlight;}
  }
  private async evaluate(request: Request) {
    try {
      const payload=parseJsonStrict(await bounded(request)) as JudgeRequest;const c=configuration(this.env);validateBinding(payload,c.chainId,c.manager);
      const client=createPublicClient({transport:http(c.rpcUrl,{timeout:12000,retryCount:1})});
      const task=await client.readContract({address:c.manager,abi:taskManagerAbi,functionName:'getTask',args:[BigInt(payload.taskId)],blockTag:'finalized'});
      if(task.status!==2||task.attempt!==BigInt(payload.attempt)||task.specHash!==payload.specHash||task.resultHash!==payload.resultHash||task.requester.toLowerCase()!==payload.spec.requester||task.worker.toLowerCase()!==payload.result.worker)throw new Error('CHAIN_BINDING_MISMATCH');
      const account=privateKeyToAccount(this.env.JUDGE_PRIVATE_KEY);
      if(!await client.readContract({address:c.manager,abi:taskManagerAbi,functionName:'isJudge',args:[account.address]}))throw new Error('UNREGISTERED_JUDGE');
      const cached=await this.ctx.storage.get<JudgeVerdict>('verdict'); if(cached)return json(cached);
      const tries=await this.ctx.storage.get<number>('attempts')??0;if(tries>=4)return json({error:'EVALUATION_RETRY_LIMIT'},503);
      await this.ctx.storage.put('attempts',tries+1);
      const evidence=payload.spec.capability === 'task.general' ? generalEvidence(payload) : await researchEvidence(payload);
      const gateway=this.env.MODEL_GATEWAY;
      const score=await scoreCompletion(payload,{apiKey:this.env.OPENROUTER_API_KEY??'',judgeId:this.env.JUDGE_ID,model:this.env.JEV_MODEL??'jev-1.13',endpoint:'https://openrouter.ai/api/v1/systemone',evidence,...(gateway?{fetch:async (_url:unknown,init?:RequestInit)=>gateway.fetch(new Request('https://model/internal/jev',{...init,headers:{'content-type':'application/json',authorization:`Bearer ${this.env.MODEL_GATEWAY_TOKEN}`}}))}:{})});
      const signature=await account.signTypedData(verdictTypedData(c.chainId,c.manager,BigInt(payload.taskId),BigInt(payload.attempt),payload.resultHash,score.completionBps));
      const verdict={judge:account.address,...score,signature};await this.ctx.storage.put('verdict',verdict);return json(verdict);
    }catch(error){
      const message=error instanceof Error?error.message:'';
      const invalid=/BINDING_MISMATCH|COMMITTED_HASH_MISMATCH|INVALID|UNSUPPORTED/.test(message);
      return json({error:invalid?'EVALUATION_PAYLOAD_INVALID':'EVALUATION_UNAVAILABLE'},invalid?422:503);
    }
  }
}
export async function researchEvidence(payload: JudgeRequest) {
  if(payload.spec.capability!=='research.web')throw new Error('UNSUPPORTED_CAPABILITY');
  const sources=z.object({sourceUrls:z.array(z.string()).min(1).max(3)}).parse(payload.spec.input).sourceUrls;
  const output=z.object({summary:z.string().max(5000),findings:z.array(z.object({title:z.string().max(500),claim:z.string().max(2000),sourceUri:z.string(),quote:z.string().min(20).max(2000)})).max(8)}).parse(judgeOutput(payload));
  const verified=await Promise.all(sources.map(async uri=>{
    const u=new URL(uri);if(u.protocol!=='https:'||u.hostname!=='docs.monad.xyz'||u.username||u.password||u.port||u.search||u.hash)throw new Error('SOURCE_INVALID');
    const response=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(12000),headers:{accept:'text/markdown,text/plain'}});
    if(!response.ok)throw new Error('SOURCE_UNAVAILABLE');
    const text=await bounded(new Request('https://source',{method:'POST',body:response.body,duplex:'half'} as RequestInit));
    return {uri,text,hash:keccak256(stringToHex(text))};
  }));
  return { findings:output.findings.map(f=>{
    const s=verified.find(s=>s.uri===f.sourceUri);const found=s?.text.indexOf(f.quote)??-1;
    return {...f,quoteVerified:found>=0,context:found>=0?s!.text.slice(Math.max(0,found-700),found+f.quote.length+700):null};
  }),sourceCoverage:sources.map(uri=>({uri,covered:output.findings.some(f=>f.sourceUri===uri)})),sources:verified.map(({uri,hash})=>({uri,contentHash:hash})) };
}

/** General delivery is judged against its committed intent. Agent references are not fetched. */
export function generalEvidence(payload: JudgeRequest) {
  if (payload.spec.capability !== 'task.general') throw new Error('UNSUPPORTED_CAPABILITY');
  const intent = payload.spec.input.intent as Record<string, unknown> | undefined;
  if (!intent) throw new Error('INTENT_INVALID');
  const { deliverable, acceptanceCriteria, ...core } = intent;
  intentSchema.parse(core);
  z.string().min(1).max(1000).parse(deliverable);
  z.array(z.string().min(1).max(300)).min(1).max(8).parse(acceptanceCriteria);
  const output = generalOutput.parse(judgeOutput(payload));
  return { mode: 'intent-and-deliverable', referencesIndependentlyVerified: false,
    notice: 'Evaluate the committed intent and delivered content. Sources are agent-supplied references, not independently fetched evidence. Do not equate a cited URL with verification of the claim or completion of an external action.',
    references: output.sources.map(source => ({ ...source, independentlyVerified: false })),
  };
}
