import { medianBps, splitReward, validQuorum, validateBinding, verifiedVerdicts, type JudgeRequest, type JudgeVerdict } from '@agent-task/judging';
import { taskManagerAbi } from '@agent-task/contracts';
import type { PlatformConfig } from './platform-domain.js';
import type { Env } from './index.js';
import { platformClient } from './platform-api.js';

export function quorumAvailable(env: Env, config: PlatformConfig) {
  return validQuorum(config.quorum) && Boolean(env.JUDGE_SERVICE_TOKEN && config.quorum.judges.every((_,i)=>env[`JUDGE_${i+1}` as 'JUDGE_1'|'JUDGE_2'|'JUDGE_3']));
}
export async function collectPlatformVerdicts(env: Env, config: PlatformConfig, payload: JudgeRequest, saved: JudgeVerdict[] = []) {
  if(!quorumAvailable(env,config))throw new Error('JUDGE_QUORUM_UNAVAILABLE');
  validateBinding(payload,config.chainId,config.manager);
  const q=config.quorum!; const client=platformClient(config);
  const [threshold,...registered]=await Promise.all([client.readContract({address:config.manager,abi:taskManagerAbi,functionName:'judgeThreshold'}),...q.judges.map(judge=>client.readContract({address:config.manager,abi:taskManagerAbi,functionName:'isJudge',args:[judge]}))]);
  if(threshold!==q.threshold || registered.some(v=>v!==true))throw new Error('JUDGE_CONFIG_INVALID');
  const replies=await Promise.allSettled(q.judges.map(async (_,i)=>{
    const binding=env[`JUDGE_${i+1}` as 'JUDGE_1'|'JUDGE_2'|'JUDGE_3']!;
    const response=await binding.fetch(new Request('https://judge/evaluate',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${env.JUDGE_SERVICE_TOKEN}`},body:JSON.stringify(payload),signal:AbortSignal.timeout(55000)}));
    if(!response.ok)throw new Error('JUDGE_UNAVAILABLE');return response.json();
  }));
  // Validate and deduplicate before testing the threshold, not merely count HTTP successes.
  return verifiedVerdicts(payload,q,[...saved,...replies.filter((r):r is PromiseFulfilledResult<unknown>=>r.status==='fulfilled').map(r=>r.value)],config.chainId,config.manager);
}
export function quorumEvidence(payload: JudgeRequest, verdicts: JudgeVerdict[], reward: bigint) {
  const completionBps=medianBps(verdicts.map(v=>v.completionBps));
  return {profile:'jev.quorum',verdict:'scored',attempt:payload.attempt,resultHash:payload.resultHash,completionBps,verdicts,...splitReward(reward,completionBps),checks:[{name:'judge-quorum',passed:true,detail:'已收集并验证裁判签名；按完成度中位数分账。'}],checkedAt:new Date().toISOString()};
}
