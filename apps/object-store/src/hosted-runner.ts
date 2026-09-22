import { sealCheckpoint, openCheckpoint } from './private-deliveries.js';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Hex } from 'viem';
import type { Env } from './index.js';
import { platformClient, platformConfig, enqueue } from './platform-api.js';
import { getRun, marketTask, storeTakerExecution, runHistory, type RunRow } from './taker-api.js';
import { getHostedJob, hostedLimits, type HostedBody } from './hosted-jobs.js';
import { executePlatformTask, type ExecutionControl } from './platform-execution.js';
import { publicPlatformError, serialize } from './platform-domain.js';

type Identity = { id: string; owner: string };
/** One actor per run. It never receives a signing client or sends a transaction directly. */
export class HostedRunner {
  private abort: AbortController | undefined;
  private busy = false;
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}
  async fetch(request: Request) {
    if (request.method !== 'POST' || !['/wake','/cancel'].includes(new URL(request.url).pathname)) return new Response('Not found',{status:404});
    const input = await request.json() as Identity;
    if (!/^[0-9a-f-]{36}$/.test(input.id) || !/^0x[0-9a-f]{40}$/.test(input.owner)) return new Response('Invalid',{status:400});
    const stored = await this.ctx.storage.get<Identity>('identity');
    if (stored && (stored.id !== input.id || stored.owner !== input.owner)) return new Response('Conflict',{status:409});
    const job = await getHostedJob(this.env,input.id,input.owner); if (!job) return new Response('Not found',{status:404});
    if (!stored) await this.ctx.storage.put('identity',input);
    if (new URL(request.url).pathname === '/cancel') this.abort?.abort(new Error('HOSTED_STOPPED'));
    if (job.active) await this.ctx.storage.setAlarm(Date.now()+1000);
    else await this.ctx.storage.deleteAlarm();
    return new Response('ok');
  }
  private async write(data: HostedBody, active = true) {
    data.updatedAt = new Date().toISOString();
    await this.env.DB!.prepare('UPDATE platform_hosted_jobs SET body=?,active=?,updated_at=? WHERE id=? AND owner=? AND cancelled=0').bind(serialize(data),active?1:0,Date.now(),data.id,data.owner).run();
  }
  private async state(data: HostedBody, status: HostedBody['status'], message: string, active = true) {
    if (data.status !== status || data.message !== message) data.logs = [...data.logs,{at:new Date().toISOString(),stage:status,message}].slice(-60);
    data.status=status;data.message=message;await this.write(data,active);
  }
  private async current(identity: Identity) {
    const [job,run]=await Promise.all([getHostedJob(this.env,identity.id,identity.owner),getRun(this.env,identity.id)]);
    if (!job || !job.active || job.cancelled || !run || run.owner !== identity.owner || run.revoked || run.executor_id || JSON.parse(run.body).hostedAgent !== job.agent) throw new Error('HOSTED_STOPPED');
    return {job,run};
  }
  private async costs(data: HostedBody, run: RunRow, events: any[]) {
    const rows=await this.env.DB!.prepare("SELECT json_group_array(json(result)) items FROM platform_commands WHERE owner=? AND id IN (?,?) AND status='complete'").bind(run.owner,`${run.id}:claim`,`${run.id}:submit`).first<{items:string}>();
    const hashes=new Set<Hex>((JSON.parse(rows?.items??'[]') as any[]).flatMap(r=>r?.transactionHash?[r.transactionHash]:[]));
    for(const event of events) if(['TaskClaimed','ResultSubmitted'].includes(event.event)&&event.args?.attempt===run.attempt&&event.args?.worker?.toLowerCase()===run.owner)hashes.add(event.transactionHash);
    const client=platformClient(platformConfig(this.env));
    for(const hash of [...hashes].slice(0,2)) {
      if(data.costs.gasTransactions.some(r=>r.hash===hash))continue;
      try { const [receipt,tx]=await Promise.all([client.getTransactionReceipt({hash}),client.getTransaction({hash})]);data.costs.gasTransactions.push({hash,paidWei:(receipt.gasUsed*receipt.effectiveGasPrice).toString(),payer:tx.from}); } catch { /* Unknown is kept as unknown, never reported as free gas. */ }
    }
    if (data.costs.gasTransactions.length) {
      const sponsor = platformConfig(this.env).sponsor.toLowerCase();
      data.costs.gasPayer = data.costs.gasTransactions.every(t=>t.payer.toLowerCase()===sponsor) ? 'platform' : data.costs.gasTransactions.every(t=>t.payer.toLowerCase()===run.owner) ? run.owner : 'mixed';
    }
    data.costs.confirmedGasWei=data.costs.gasTransactions.length?data.costs.gasTransactions.reduce((sum,r)=>sum+BigInt(r.paidWei),0n).toString():null;
  }
  async alarm() {
    if(this.busy)return;this.busy=true;
    const identity=await this.ctx.storage.get<Identity>('identity');if(!identity){this.busy=false;return;}
    let data:HostedBody|undefined;
    try {
      const initial=await getHostedJob(this.env,identity.id,identity.owner);if(!initial?.active||initial.cancelled)return;data=initial.data;
      await this.ctx.storage.setAlarm(Date.now()+10000);
      let {run}=await this.current(identity);const grant=JSON.parse(run.body);
      const {task,spec,goal}=await marketTask(this.env,run.task_id);const history=runHistory(run,goal,task);
      if(task.status===3&&task.worker.toLowerCase()===run.owner&&String(task.attempt)===run.attempt&&task.resultHash===run.result_hash){
        await this.costs(data,run,history.events);
        if(history.settlement){await this.state(data,'settled_scored','交付已按裁判完成度分账，请查看实际付款与退款。',false);return;}const verified=history.evidence?.verdict==='accept';await this.state(data,verified?'completed':'settled_unverified',verified?'交付已通过独立审核，奖励已结算到你的钱包。':'本轮已发生链上结算，但没有匹配的通过证据；结算不等于质量通过。',false);return;
      }
      if(task.status>=4||history.superseded){await this.costs(data,run,history.events);const rejected=history.evidence?.verdict==='reject';await this.state(data,rejected?'rejected':'expired',rejected?'独立审核拒绝了本轮交付；如继续，需准备新一轮领取。':'本轮已结束或租约已释放；没有继续提交旧结果。',false);return;}
      const now=(await platformClient(platformConfig(this.env)).getBlock({blockTag:'finalized'})).timestamp;
      if(BigInt(grant.validUntil)<=now||task.taskDeadline<=now){await this.state(data,'expired','本轮授权或任务已到期，托管执行已停止。',false);return;}
      if(task.status===0){await this.state(data,'stopped','平台托管执行已停用，请使用外部 Agent 接单。',false);return;}
      if(!grant.authorized){await this.state(data,'waiting_authorization','等待本轮钱包授权。');return;}
      if(task.worker.toLowerCase()!==run.owner||String(task.attempt)!==run.attempt)throw new Error('HOSTED_ATTEMPT_CHANGED');
      if(task.status===2){await this.costs(data,run,history.events);await this.state(data,'reviewing','结果已提交链上，等待 requester 独立审核。');return;}
      if(task.status!==1)throw new Error('HOSTED_ATTEMPT_CHANGED');
      if(task.claimLeaseExpiresAt-now<=20n){await this.state(data,'expired','本轮提交时间不足，已停止计算；不会把旧结果提交到下一轮。',false);return;}
      await this.costs(data,run,history.events);
      if(!run.result_hash){
        let execution=await openCheckpoint(this.env,await this.ctx.storage.get<any>('execution'),run.id);
        if(!execution){
          if(data.metrics.executionTries>=hostedLimits.executionTries)throw new Error('HOSTED_TRIES_EXHAUSTED');
          data.metrics.executionTries++;
          await this.state(data,'running','正在云端执行；你可以离开页面，稍后查看结果。');
          this.abort=new AbortController();
          const timeout=Math.min(hostedLimits.executionTimeoutSeconds*1000,Number(task.claimLeaseExpiresAt-now-20n)*1000);
          const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(timeout)]);
          let chain=Promise.resolve();
          const control:ExecutionControl={signal,modelContext:{owner:run.owner,taskId:run.task_id,attempt:run.attempt,runId:run.id},checkpoint:stage=>{
            chain=chain.then(async()=>{
              signal.throwIfAborted();await this.current(identity);
              if(stage==='model'){data!.metrics.modelRequests++;}
              if(stage==='source'||stage==='rpc')data!.metrics.toolQueries++;
              const message=stage==='model'?'正在生成交付；模型只接收本任务与指定来源。':stage==='source'?'正在读取任务指定的公开来源。':stage==='rpc'?'正在查询任务约定的链上数据。':'正在检查交付格式与来源记录。';
              await this.state(data!,'running',message);signal.throwIfAborted();await this.current(identity);
            });return chain;
          }};
          // Only these capabilities reach the execution adapter: no signer keys or other tenant state.
          const executionEnv={AI:this.env.AI,DB:this.env.DB,PLATFORM_AI_MODEL:this.env.PLATFORM_AI_MODEL,PLATFORM_GENERATION_PROVIDER:this.env.PLATFORM_GENERATION_PROVIDER,OPENROUTER_API_KEY:this.env.OPENROUTER_API_KEY,OPENROUTER_FREE_MODELS:this.env.OPENROUTER_FREE_MODELS,MPP_TOOL_CONFIG:this.env.MPP_TOOL_CONFIG,TOOL_PAYMENTS:this.env.TOOL_PAYMENTS} as Env;
          execution=await executePlatformTask(spec,platformConfig(this.env),executionEnv,undefined,control);
          signal.throwIfAborted();await this.current(identity);
          await this.ctx.storage.put('execution',spec.delivery ? await sealCheckpoint(this.env,execution,run.id) : execution);
        }
        ({run}=await this.current(identity));
        const { artifacts = [], ...executionPayload } = execution;
        const result=await storeTakerExecution(this.env,run,executionPayload,artifacts);data.resultHash=result.hash;
        await this.state(data,'ready','交付已保存，等待链上提交。');
        ({run}=await this.current(identity));
      }
      if (run.result_hash) data.resultHash=run.result_hash;
      if(JSON.parse(run.body).mode==='sponsored'){
        await this.current(identity);
        const command=await enqueue(this.env,run.owner,`${run.id}:submit`,'taker-submit',{runId:run.id});
        if(command.status==='failed')throw new Error('HOSTED_SUBMIT_FAILED');
        await this.state(data,'submitting','已请求使用本轮权限提交，等待链上确认。');
      }else await this.state(data,'ready','云端交付已准备好，请在本轮截止前用钱包确认提交。');
      await this.ctx.storage.put('infra-retries',0);
    }catch(error){
      const fresh=await getHostedJob(this.env,identity.id,identity.owner);if(!fresh?.active||fresh.cancelled)return;
      data??=fresh.data;
      const message=String(error);
      if(message.includes('HOSTED_STOPPED')){await this.state(data,'stopped','本轮授权已改变，托管执行已停止；已签名交易仍可能确认。',false);return;}
      if(/HOSTED_ATTEMPT_CHANGED|CLAIM_REQUIRED/.test(message)){await this.state(data,'expired','链上领取者或轮次已改变，没有上传或提交越界结果。',false);return;}
      if(/HOSTED_MODEL_QUOTA|MODEL_DAILY_LIMIT|MODEL_MINUTE_LIMIT/.test(message)){await this.state(data,'failed','平台托管模型额度已用完，本轮未继续推理；可转为钱包接管。',false);return;}
      const retries=(await this.ctx.storage.get<number>('infra-retries')??0)+1;await this.ctx.storage.put('infra-retries',retries);
      const permanent=/MODEL_(?:FREE_UNAVAILABLE|POLICY_VIOLATION|ACCESS_UNAVAILABLE|NO_FREE_PROVIDER|FREE_ONLY|UNAVAILABLE)|HOSTED_.*FAILED|RESULT_CONFLICT|SPEC_MISMATCH|HOSTED_TRIES_EXHAUSTED/.test(message)||data.metrics.executionTries>=hostedLimits.executionTries||retries>=8;
      await this.state(data,permanent?'failed':'running',permanent?(message.includes('MODEL_')?`${publicPlatformError(error)} 本轮未提交，可在租约内手工接管。`:'托管执行未完成，已停止重试；没有把失败标为交付成功，可在租约内手工接管。'):'本次执行未完成，正在保留原 run 与已保存产物并有限重试。',!permanent);
    }finally{
      this.abort=undefined;this.busy=false;
      const current=await getHostedJob(this.env,identity.id,identity.owner);
      if(current?.active)await this.ctx.storage.setAlarm(Date.now()+(['waiting_authorization','ready'].includes(current.data.status)?30000:15000));else await this.ctx.storage.deleteAlarm();
    }
  }
}
