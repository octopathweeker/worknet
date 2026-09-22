import type { Env } from './index.js';
import { parseJsonStrict } from '@agent-task/protocol/json';

export type ModelStage = 'generation' | 'quotation-review' | 'delivery-review';
export type ModelContext = { owner: string; taskId: string; attempt: string; runId?: string };
export type ModelControl = { signal?: AbortSignal; beforeAttempt?(): Promise<void>; context?: ModelContext };
export const defaultFreeModels = ['nex-agi/nex-n2.5-mini:free', 'nex-agi/nex-n2.5-pro:free'];
export function freeModels(env: Env): string[] {
  const models = (env.OPENROUTER_FREE_MODELS ?? defaultFreeModels.join(',')).split(',').map(s => s.trim());
  if (!models.length || models.length > 3 || new Set(models).size !== models.length || models.some(m => !/^[a-z0-9._-]+\/[a-z0-9._-]+:free$/.test(m))) throw new Error('MODEL_FREE_ONLY');
  return models;
}
export function generationAvailable(env: Env) {
  if (env.PLATFORM_GENERATION_PROVIDER === 'openrouter') { try { freeModels(env); return Boolean(env.OPENROUTER_API_KEY || env.MODEL_GATEWAY && env.MODEL_GATEWAY_TOKEN); } catch { return false; } }
  return (!env.PLATFORM_GENERATION_PROVIDER || env.PLATFORM_GENERATION_PROVIDER === 'cloudflare') && Boolean(env.AI && env.PLATFORM_AI_MODEL);
}
export async function reserveModelAttempt(env: Env, provider: string, stage: ModelStage) {
  if (!env.DB) return; // Pure adapter tests may omit storage; deployed platform always requires D1.
  const group = stage === 'generation' ? 'generation' : 'review';
  // Review has a separate allowance: new generation cannot spend the review reserve.
  const limit = group === 'generation' ? 40 : 100;
  const key = `${new Date().toISOString().slice(0,10)}:${provider}:${group}`;
  const row = await env.DB.prepare('INSERT INTO platform_model_budgets(key,requests) VALUES (?,1) ON CONFLICT(key) DO UPDATE SET requests=requests+1 WHERE requests<? RETURNING requests').bind(key,limit).first();
  if (!row) throw new Error('MODEL_DAILY_LIMIT');
  if (provider === 'openrouter') {
    const minute = `${Math.floor(Date.now()/60000)}:openrouter:minute`;
    const rate = await env.DB.prepare('INSERT INTO platform_model_budgets(key,requests) VALUES (?,1) ON CONFLICT(key) DO UPDATE SET requests=requests+1 WHERE requests<18 RETURNING requests').bind(minute).first();
    if (!rate) throw new Error('MODEL_MINUTE_LIMIT');
  }
}
async function begin(env: Env, provider: string, stage: ModelStage, model: string, context?: ModelContext) {
  await reserveModelAttempt(env,provider,stage);
  const id = crypto.randomUUID();
  if (env.DB) await env.DB.prepare("INSERT INTO platform_model_calls(id,owner,task_id,attempt,run_id,provider,stage,model,status,created_at) VALUES (?,?,?,?,?,?,?,?,'started',?)")
    .bind(id,context?.owner ?? '',context?.taskId ?? '',context?.attempt ?? '',context?.runId ?? null,provider,stage,model,Date.now()).run();
  return id;
}
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
async function finish(env: Env, id: string, status: string, usage?: any) {
  if (env.DB) await env.DB.prepare('UPDATE platform_model_calls SET status=?,input_tokens=?,output_tokens=?,finished_at=? WHERE id=?')
    .bind(status,count(usage?.prompt_tokens ?? usage?.input_tokens),count(usage?.completion_tokens ?? usage?.output_tokens),Date.now(),id).run();
}
function parseResponse(value: unknown) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') throw new Error('MODEL_RESPONSE_INVALID');
  return parseJsonStrict(value.replace(/^<think>[\s\S]*?<\/think>\s*/, '').replace(/^```json\s*/, '').replace(/\s*```$/, '').trim());
}
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { pending.catch(()=>undefined); throw signal.reason; }
  return new Promise((resolve,reject)=>{
    const stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});
    pending.then(v=>{signal.removeEventListener('abort',stop);resolve(v);},e=>{signal.removeEventListener('abort',stop);reject(e);});
  });
}
// No prompts, source text, response text, credentials, or provider error bodies go into the ledger.
export async function callPlatformModel(env: Env, system: string, input: unknown, stage: ModelStage, control?: ModelControl): Promise<{ value: any; model: string; provider: string }> {
  const generation = stage === 'generation';
  if (generation && env.MODEL_GATEWAY && env.MODEL_GATEWAY_TOKEN) {
    await control?.beforeAttempt?.();
    const response = await env.MODEL_GATEWAY.fetch(new Request('https://model/internal/model', { method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${env.MODEL_GATEWAY_TOKEN}`},body:JSON.stringify({system,input,stage,context:control?.context}),signal:control?.signal ?? AbortSignal.timeout(110000) }));
    if (!response.ok) throw new Error(response.status===429?'MODEL_DAILY_LIMIT':'MODEL_UNAVAILABLE');
    return response.json() as Promise<{value:any;model:string;provider:string}>;
  }
  const provider = generation ? env.PLATFORM_GENERATION_PROVIDER ?? 'cloudflare' : 'cloudflare';
  const messages = [{role:'system',content:system+' Return only JSON.'},{role:'user',content:JSON.stringify(input)}];
  const signal = control?.signal ? AbortSignal.any([control.signal,AbortSignal.timeout(110000)]) : AbortSignal.timeout(110000);
  if (provider === 'cloudflare') {
    const model = generation ? env.PLATFORM_AI_MODEL : env.PLATFORM_JUDGE_MODEL;
    if (!env.AI || !model) throw new Error('MODEL_UNAVAILABLE');
    signal.throwIfAborted();const id=await begin(env,provider,stage,model,control?.context);
    let reportedUsage:unknown;
    try {
      await control?.beforeAttempt?.();signal.throwIfAborted();
      const response = await abortable(env.AI.run(model as any,{messages,max_tokens:generation?1800:4096,temperature:0,response_format:{type:'json_object'}}),signal) as any;
      reportedUsage=response.usage;signal.throwIfAborted();const value=parseResponse(response.response ?? response.choices?.[0]?.message?.content);
      await finish(env,id,'succeeded',response.usage);return{value,model,provider};
    } catch { await finish(env,id,signal.aborted?'interrupted':'failed',reportedUsage);signal.throwIfAborted();throw new Error('MODEL_RESPONSE_INVALID'); }
  }
  if (provider !== 'openrouter') throw new Error('MODEL_PROVIDER_INVALID');
  const allowed = freeModels(env);if (!env.OPENROUTER_API_KEY) throw new Error('MODEL_UNAVAILABLE');
  // workerd supports follow/manual, not redirect:error. Manual + !ok rejects redirects
  // without forwarding credentials to a different endpoint.
  // Fresh catalog check fails closed if pricing is missing/nonzero. Never trust a suffix alone.
  let catalog:any;
  try {
    const response=await fetch('https://openrouter.ai/api/v1/models',{signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),redirect:'manual'});
    if(!response.ok){await response.body?.cancel();throw new Error(`MODEL_CATALOG_HTTP_${response.status}`);}catalog=await response.json();
  } catch(error) {signal.throwIfAborted();const code=String(error).match(/MODEL_CATALOG_HTTP_[0-9]{3}/)?.[0];throw new Error(code??'MODEL_CATALOG_UNAVAILABLE');}
  const models=allowed.filter(id=>catalog.data?.some((m:any)=>m.id===id && m.pricing && ['prompt','completion'].every(k=>m.pricing[k]!==undefined&&Number(m.pricing[k])===0) && Object.values(m.pricing).every(v=>v!==null&&Number(v)===0) && m.supported_parameters?.includes('response_format')));
  if(!models.length)throw new Error('MODEL_NO_FREE_PROVIDER');
  for(const model of models) {
    signal.throwIfAborted();const id=await begin(env,provider,stage,model,control?.context);
    let recorded=false;let reportedUsage:unknown;
    try {
      await control?.beforeAttempt?.();signal.throwIfAborted();
      const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(30000)]),headers:{authorization:`Bearer ${env.OPENROUTER_API_KEY}`,'content-type':'application/json'},body:JSON.stringify({model,messages,max_tokens:1800,temperature:0,stream:false,response_format:{type:'json_object'},provider:{require_parameters:true,allow_fallbacks:true,data_collection:'deny',max_price:{prompt:0,completion:0,request:0,image:0}},plugins:[]})});
      if(!response.ok){await response.body?.cancel();await finish(env,id,`http_${response.status}`);recorded=true;if([401,402,403].includes(response.status))throw new Error('MODEL_ACCESS_UNAVAILABLE');continue;}
      const result=await response.json() as any;reportedUsage=result.usage;
      // Some providers return the canonical ID without :free. Only the requested base may match.
      if(result.model!==model&&result.model!==model.replace(/:free$/,''))throw new Error('MODEL_POLICY_VIOLATION');
      if(result.usage?.cost!==undefined&&Number(result.usage.cost)!==0)throw new Error('MODEL_POLICY_VIOLATION');
      if(result.error||result.choices?.[0]?.finish_reason==='length')throw new Error('MODEL_RESPONSE_INVALID');
      signal.throwIfAborted();const value=parseResponse(result.choices?.[0]?.message?.content);
      await finish(env,id,'succeeded',result.usage);return{value,model,provider};
    } catch(error) {
      if(!recorded)await finish(env,id,signal.aborted?'interrupted':'failed',reportedUsage);
      signal.throwIfAborted();if(/MODEL_ACCESS_UNAVAILABLE|MODEL_POLICY_VIOLATION/.test(String(error)))throw error;
    }
  }
  throw new Error('MODEL_FREE_UNAVAILABLE');
}
export async function taskModelUsage(env: Env, taskId: string, attempt: string) {
  const row=await env.DB!.prepare("SELECT json_group_array(json(item)) items FROM (SELECT json_object('provider',provider,'stage',stage,'model',model,'requests',count(*),'succeeded',sum(status='succeeded'),'inputTokens',sum(input_tokens),'outputTokens',sum(output_tokens),'unknownUsage',sum(input_tokens IS NULL OR output_tokens IS NULL)) item FROM platform_model_calls WHERE task_id=? AND attempt=? GROUP BY provider,stage,model)").bind(taskId,attempt).first<{items:string}>();
  return JSON.parse(row?.items ?? '[]');
}
