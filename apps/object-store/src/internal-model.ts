import { z } from 'zod';
import { platformBody, platformRate } from './platform-api.js';
import { callPlatformModel, reserveModelAttempt } from './model-gateway.js';
import type { Env } from './index.js';

/** Authenticated service gateway reuses the existing OpenRouter Secret without exporting it. */
export async function internalModel(request: Request, env: Env) {
  const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  if(request.method!=='POST')return reply({error:'NOT_FOUND'},404);
  const token=env.MODEL_GATEWAY_TOKEN;const authorization=request.headers.get('authorization')??'';
  if(!token||token.length<32||authorization.length>512)return reply({error:'UNAUTHORIZED'},401);
  const enc=new TextEncoder();const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',enc.encode(authorization)),crypto.subtle.digest('SHA-256',enc.encode(`Bearer ${token}`))]);
  let different=0;new Uint8Array(a).forEach((v,i)=>{different|=v^new Uint8Array(b)[i]!;});if(different)return reply({error:'UNAUTHORIZED'},401);
  let stage='parse';
  try{
    const body=await platformBody(request,256000);
    if(new URL(request.url).pathname==='/internal/jev'){
      if(!env.OPENROUTER_API_KEY)return reply({error:'MODEL_UNAVAILABLE'},503);
      const input=z.object({model:z.enum(['jev-1.13','typesafe/jev-1.13']),state:z.unknown(),questions:z.record(z.string(),z.unknown())}).strict().parse(body);
      stage='rate';await platformRate(env,'jev:minute',18);stage='budget';await reserveModelAttempt(env,'openrouter-jev','delivery-review');
      stage='provider';const response=await fetch('https://openrouter.ai/api/v1/systemone',{method:'POST',redirect:'manual',headers:{authorization:`Bearer ${env.OPENROUTER_API_KEY}`,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(15000)});
      if(!response.ok){await response.body?.cancel();return reply({error:'JEV_UNAVAILABLE'},[429,529].includes(response.status)?response.status:503);}
      stage='decode';const result=await response.json() as any;
      if(typeof result.model!=='string'||!result.model.includes('jev'))return reply({error:'JEV_MODEL_MISMATCH'},503);
      return reply({model:result.model,answers:result.answers,usage:result.usage});
    }
    if(new URL(request.url).pathname==='/internal/model'){
      const input=z.object({system:z.string().max(16000),input:z.unknown(),stage:z.literal('generation'),context:z.object({owner:z.string(),taskId:z.string(),attempt:z.string(),runId:z.string().optional()}).optional()}).strict().parse(body);
      return reply(await callPlatformModel({...env,MODEL_GATEWAY:undefined},input.system,input.input,input.stage,input.context?{context:{owner:input.context.owner,taskId:input.context.taskId,attempt:input.context.attempt,...(input.context.runId?{runId:input.context.runId}:{})}}:undefined));
    }
    return reply({error:'NOT_FOUND'},404);
  }catch(error){console.error('internal-model-failed',{stage,errorName:error instanceof Error?error.name:'Unknown'});return reply({stage,error:/RATE_LIMIT|MODEL_.*LIMIT/.test(String(error))?'MODEL_LIMIT':'MODEL_UNAVAILABLE'},/RATE_LIMIT|MODEL_.*LIMIT/.test(String(error))?429:503);}
}
