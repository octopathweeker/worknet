import {hashJson} from '@agent-task/protocol/json';
import type {Env} from './index.js';

type Activity = {id:string;kind:'goal'|'run';targetId:string;taskId?:string;title:string;message:string;state:string;read:boolean;updatedAt:number};
// Notifications are current-state summaries, never independent payment authority.
export function activityState(goal:any, run?:any, hosted?:any, now=Date.now()):{state:string;message:string}|null {
 const task=goal?.task; const status=Number(task?.status); const seconds=now/1000;
 if(run){
  const body=JSON.parse(run.body); const same=String(task?.attempt)===run.attempt&&task?.worker?.toLowerCase()===run.owner;
  const paid=same&&status===3&&run.result_hash&&task.resultHash===run.result_hash;
  if(paid&&goal.settlement)return {state:'settled',message:'交付已按裁判完成度分账，请查看实际付款与退款。'};
  if(paid){const evidence=[goal.evidence,...(goal.verificationHistory??[])].find((e:any)=>e?.attempt===run.attempt&&e?.resultHash===run.result_hash);return {state:'settled',message:evidence?.verdict==='accept'?'本轮已结算；请打开任务核对审核与付款记录。':'本轮已结算，但不代表质量审核通过；请核对付款原因。'};}
  if(status>=4)return {state:'ended',message:'任务已取消或到期；本轮没有据此产生收款证明。'};
  if(task&&(BigInt(task.attempt)>BigInt(run.attempt)||status===0&&BigInt(task.attempt)>=BigInt(run.attempt)||String(task.attempt)===run.attempt&&status>0&&!same))return {state:'superseded',message:'本轮已结束或任务已由其他账户领取。查看旧交付；后续轮次收入不属于本轮。'};
  if(same&&status===2)return {state:seconds>=Number(task.reviewDeadline)?'review-timeout':'reviewing',message:seconds>=Number(task.reviewDeadline)?'审核窗口已结束，等待链上结算确认；超时付款不代表质量通过。':'交付已提交，等待 requester 审核。可查看审核截止时间。'};
  if(same&&status===1&&seconds>=Number(task.claimLeaseExpiresAt))return {state:'lease-expired',message:'领取租约已到期，请刷新并等待链上释放；不要继续提交旧轮次。'};
  if(run.revoked)return {state:'stopped',message:'本轮平台操作已停止。已签名交易仍可能确认；有效租约内可用钱包接管。'};
  if(['failed','stopped'].includes(hosted?.status))return {state:hosted.status,message:'托管执行未完成。请查看运行记录；有效租约内可转为钱包接管。'};
  if(body.validUntil*1000<=now)return {state:'grant-expired',message:'本轮权限已到期；已领取且租约有效时可转为钱包接管。'};
  if(same&&status===1&&run.result_hash&&body.mode==='wallet')return {state:'submit-required',message:'交付已保存，请在租约结束前由钱包确认提交。'};
  if(!body.authorized)return {state:'authorization-required',message:'领取计划已准备，等待你确认本轮钱包授权。'};
  return null;
 }
 if(!task){if(goal?.error||goal?.publication?.status==='failed')return {state:'publish-failed',message:'发布未完成。请打开原计划核对预算和原请求，不要重复新建任务。'};return null;}
 if(status===3&&goal.settlement)return {state:'settled',message:'交付已按裁判完成度分账，请查看实际付款与退款。'};
 if(status===3)return {state:'settled',message:goal.status==='completed'?'任务已交付并结算，可查看成果和付款记录。':'任务已结算，仍需核对审核结论；付款本身不代表质量通过。'};
 if(status>=4)return {state:'ended',message:'任务已取消或到期，请核对退款与预算余额。'};
 if(status===2)return {state:seconds>=Number(task.reviewDeadline)?'review-timeout':'review-required',message:seconds>=Number(task.reviewDeadline)?'审核期限已过，可能发生超时付款；请查看链上结算。':'交付进入审核窗口；需要时可在截止前由 Owner 接受或拒绝。'};
 if(goal.error)return {state:'attention',message:'任务需要处理。打开详情查看原因与恢复步骤，保留原任务和交易记录。'};
 if(status===0&&Number(task.taskDeadline)-seconds<600)return {state:'deadline',message:'任务即将到期且尚未领取，可等待到期退款，或由 Owner 取消。'};
 return null;
}
export async function platformActivity(env:Env,owner:string,now=Date.now()):Promise<Activity[]> {
 const goals=await env.DB!.prepare('SELECT json_group_array(json_object(\'body\',json(body),\'updatedAt\',updated_at)) items FROM (SELECT body,updated_at FROM platform_goals WHERE owner=? ORDER BY updated_at DESC LIMIT 60)').bind(owner).first<{items:string}>();
 const runs=await env.DB!.prepare("SELECT json_group_array(json_object('run',json(rbody),'goal',json(gbody),'hosted',json(hbody),'updatedAt',updated_at)) items FROM (SELECT json_object('id',r.id,'owner',r.owner,'attempt',r.attempt,'body',r.body,'result_hash',r.result_hash,'revoked',r.revoked,'task_id',r.task_id) rbody,g.body gbody,h.body hbody,max(r.created_at,coalesce(g.updated_at,0),coalesce(h.updated_at,0)) updated_at FROM platform_runs r LEFT JOIN platform_goals g ON json_extract(g.body,'$.taskId')=r.task_id LEFT JOIN platform_hosted_jobs h ON h.id=r.id AND h.owner=r.owner WHERE r.owner=? ORDER BY updated_at DESC LIMIT 60)").bind(owner).first<{items:string}>();
 const seen=await env.DB!.prepare('SELECT json_group_array(id) items FROM platform_activity_reads WHERE owner=?').bind(owner).first<{items:string}>();const read=new Set(JSON.parse(seen?.items??'[]'));
 const items:Activity[]=[];
 function append(kind:'goal'|'run',id:string,g:any,r:any,h:any,at:number){const state=activityState(g,r,h,now);if(!state)return;const key=hashJson({kind,id,state:state.state,attempt:r?.attempt??String(g?.task?.attempt??''),result:r?.result_hash??g?.task?.resultHash??null});items.push({id:key,kind,targetId:id,taskId:r?.task_id??g?.taskId,title:g?.input?.goal??`任务 #${r?.task_id}`,message:state.message,state:state.state,read:read.has(key),updatedAt:at});}
 for(const {body,updatedAt} of JSON.parse(goals?.items??'[]'))append('goal',body.id,body,null,null,updatedAt);
 for(const {run,goal,hosted,updatedAt} of JSON.parse(runs?.items??'[]'))append('run',run.id,goal,run,hosted,updatedAt);
 return items.sort((a,b)=>b.updatedAt-a.updatedAt);
}
export async function markActivityRead(env:Env,owner:string,ids:string[]){
 const current=await platformActivity(env,owner); const allowed=new Set(current.map(i=>i.id));
 for(const id of new Set(ids))if(allowed.has(id))await env.DB!.prepare('INSERT OR IGNORE INTO platform_activity_reads(owner,id,created_at) VALUES (?,?,?)').bind(owner,id,Date.now()).run();
 // Reads expire only outside the visible window. Bound per-owner storage without changing other users.
 await env.DB!.prepare('DELETE FROM platform_activity_reads WHERE owner=? AND id NOT IN (SELECT id FROM platform_activity_reads WHERE owner=? ORDER BY created_at DESC LIMIT 500)').bind(owner,owner).run();
}
