import {z} from 'zod';
import type {Env} from './index.js';
export async function marketList(env:Env,params:URLSearchParams,now=Date.now()){
 const filter=z.object({q:z.string().trim().max(100).default(''),capability:z.enum(['all','research.web','analysis.token-transfers']).default('all'),state:z.enum(['all','open','active','ended']).default('all'),sort:z.enum(['recent','reward','deadline']).default('recent')}).parse(Object.fromEntries(params));
 const where=["json_extract(body,'$.taskId') IS NOT NULL","json_extract(body,'$.input.execution')='market'"];const values:(string|number)[]=[];
 if(filter.q){where.push("instr(lower(json_extract(body,'$.input.goal')),lower(?))>0");values.push(filter.q);}
 if(filter.capability!=='all'){where.push("json_extract(body,'$.spec.capability')=?");values.push(filter.capability);}
 const status="CAST(json_extract(body,'$.task.status') AS INTEGER)";
 if(filter.state==='open'){where.push(`${status}=0 AND CAST(json_extract(body,'$.task.taskDeadline') AS INTEGER)>?`);values.push(Math.floor(now/1000));}
 if(filter.state==='active')where.push(`${status} IN (1,2)`);
 if(filter.state==='ended')where.push(`${status}>=3`);
 const order={recent:'updated_at DESC,id',reward:"CAST(json_extract(body,'$.input.reward') AS INTEGER) DESC,updated_at DESC,id",deadline:"CAST(json_extract(body,'$.task.taskDeadline') AS INTEGER),id"}[filter.sort];
 const predicate=where.join(' AND ');
 const rows=await env.DB!.prepare(`SELECT json_group_array(json(body)) items FROM (SELECT body FROM platform_goals WHERE ${predicate} ORDER BY ${order} LIMIT 60)`).bind(...values).first<{items:string}>();
 const count=await env.DB!.prepare(`SELECT count(*) total FROM platform_goals WHERE ${predicate}`).bind(...values).first<{total:number}>();
 return {tasks:JSON.parse(rows?.items??'[]').map((g:any)=>({taskId:g.taskId,spec:g.spec,task:g.task,evidence:g.evidence,status:g.status})),total:count?.total??0,limit:60};
}
