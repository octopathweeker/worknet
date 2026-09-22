import { agentGrant, startAgent, prepareAgent, approveAgent, inspectAgent } from './agent-account.js';
import { protectResult, reviewResult } from './private-deliveries.js';
import { validateResultManifest } from '@agent-task/protocol';
import { assignmentSnapshot, waitForAssignments } from './taker-wait.js';
import {marketList} from './market-query.js';
import { taskModelUsage } from './model-gateway.js';
import { z } from 'zod';
import { encodeFunctionData, keccak256, stringToHex, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { taskManagerAbi } from '@agent-task/contracts';
import { delegationStatusAbi,accountEnvironment,hashDelegation,exactPermission, taskSubmissionPermission, permissionTypedData, isSupportedDelegation, type AccountCall } from '@agent-task/accounts';
import { canonicalJson, hashJson } from '@agent-task/protocol/json';
import { platformBody, platformClient, platformConfig, platformSession, platformRate, enqueue } from './platform-api.js';
import { idSchema, serialize, researchOutput, transferOutput, type PlatformGoal } from './platform-domain.js';
import type { Env } from './index.js';
import { hostedAgentSchema, hostedAgents, hostedCatalog, ensureHostedJob, getHostedJob, stopHostedJob } from './hosted-jobs.js';
import { inputIssues } from './input-errors.js';
import { identityManifestFields } from './platform-identity.js';
import { taskToolPayments, purchaseTransferTool, externalToolArtifacts } from './tool-payments.js';
import { toolPaymentConfigSchema } from './mpp-policy.js';
import type { ResultManifest } from '@agent-task/protocol';

const taskIdSchema = z.string().regex(/^[1-9][0-9]{0,76}$/);
const signatureSchema = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const numberString = z.string().regex(/^(0|[1-9][0-9]{0,76})$/);
export const executionSchema = z.object({ output: z.unknown(), provenance: z.object({
  toolVersion: z.string().min(1).max(200), sourceChainId: numberString.optional(),
  blockRange: z.object({ fromBlock: numberString, toBlock: numberString, toBlockHash: hashSchema }).strict().optional(),
  sources: z.array(z.object({ uri: z.string().url().max(512), retrievedAt: z.number().int().nonnegative(), contentHash: hashSchema }).strict()).max(3).optional(),
}).strict() }).strict();
export type ExecutorRow = { id: string; token_hash: string; owner: Address | null; name: string; approved: number; revoked: number; expires_at: number; created_at: number };
export type RunRow = { id: string; owner: Address; executor_id: string | null; task_id: string; attempt: string; body: string; result_hash: Hex | null; result_body: string | null; revoked: number; created_at: number };
export async function getRun(env: Env, id: string) { return env.DB!.prepare('SELECT * FROM platform_runs WHERE id=?').bind(id).first<RunRow>(); }
export async function executorActive(env: Env, id: string, owner: Address) {
  return env.DB!.prepare('SELECT id FROM platform_executors WHERE id=? AND owner=? AND approved=1 AND revoked=0 AND expires_at>?').bind(id, owner, Date.now()).first();
}
export async function marketTask(env: Env, id: string) {
  const row = await env.DB!.prepare("SELECT body FROM platform_goals WHERE json_extract(body,'$.taskId')=? AND json_extract(body,'$.input.execution')='market' LIMIT 1").bind(id).first<{ body: string }>();
  if (!row) throw new Error('TASK_NOT_FOUND');
  const goal = JSON.parse(row.body) as PlatformGoal; const config = platformConfig(env);
  const task = await platformClient(config).readContract({ address: config.manager, abi: taskManagerAbi, functionName: 'getTask', args: [BigInt(id)], blockTag: 'finalized' });
  if (!goal.spec || hashJson(goal.spec) !== task.specHash) throw new Error('SPEC_MISMATCH');
  // Terminal goals no longer tick. Read the index here so late finalized settlement events remain visible.
  const indexed = await env.DB!.prepare('SELECT json_group_array(json(body)) items FROM (SELECT body FROM platform_events WHERE task_id=? ORDER BY block_number)').bind(id).first<{ items: string }>();
  const events = JSON.parse(indexed?.items ?? '[]') as any[];
  goal.events = [...(goal.events ?? []).filter(e => !events.some(i => i.transactionHash === e.transactionHash)), ...events];
  return { task, spec: goal.spec, goal };
}
export function claimCall(manager: Address, taskId: string): AccountCall { return { target: manager, value: 0n, callData: encodeFunctionData({ abi: taskManagerAbi, functionName: 'claimTask', args: [BigInt(taskId)] }) }; }
export function submitCall(manager: Address, run: RunRow, storage: string): AccountCall {
  if (!run.result_hash) throw new Error('RESULT_REQUIRED');
  return { target: manager, value: 0n, callData: encodeFunctionData({ abi: taskManagerAbi, functionName: 'submitResult', args: [BigInt(run.task_id), BigInt(run.attempt), run.result_hash, `${storage}/objects/${run.result_hash}`] }) };
}
async function runPublic(row: RunRow, wallet: boolean, env: Env) {
  const body = JSON.parse(row.body);
  const hosted = body.hostedAgent || body.previousHostedAgent ? await getHostedJob(env,row.id,row.owner) : null;
  const tools = row.executor_id && body.spec?.capability === 'analysis.token-transfers' && env.MPP_TOOL_CONFIG && env.MPP_PAYER_KEY && env.TOOL_PAYMENTS ? toolPaymentConfigSchema.parse(JSON.parse(env.MPP_TOOL_CONFIG)) : undefined;
  return { toolPayments: env.MPP_TOOL_CONFIG ? await taskToolPayments(env,row.task_id,row.attempt) : [], hostedAgent: body.hostedAgent ?? null, hosted: hosted?.data ?? null, id: row.id, owner: row.owner, executorId: row.executor_id, taskId: row.task_id, attempt: row.attempt, mode: body.mode, authorized: Boolean(body.authorized), validUntil: body.validUntil, revoked: Boolean(row.revoked), resultHash: row.result_hash, result: row.result_body ? JSON.parse(row.result_body) : null, createdAt: row.created_at,
    platformTools: tools ? [{name:'transfers',payer:'platform',currency:'test USDC',decimals:6,maxPerCall:tools.maxPerCall,maxPerTask:tools.maxPerTask,maxPerDay:tools.maxPerDay}] : [],
    ...(wallet ? { permissions: body.claimPermission?.signature !== '0x' && body.claimPermission?.signature ? [body.claimPermission, body.submitPermission] : [] } : {}) };
}

export function runHistory(row: RunRow, goal: PlatformGoal, task: { attempt: bigint; status: number }) {
  const evidence = [goal.evidence, ...(goal.verificationHistory ?? [])].find(e => e && e.attempt === row.attempt && e.resultHash === row.result_hash);
  const events = (goal.events ?? []).filter(event => {
    if (event.event === 'TaskSettled') return event.args?.attempt === row.attempt && event.args?.worker?.toLowerCase() === row.owner;
    if (event.event === 'VerdictSettled') return task.attempt === BigInt(row.attempt) && goal.task?.resultHash === row.result_hash && event.args?.worker?.toLowerCase() === row.owner;
    if (event.event === 'quorum-settle' || event.event === 'accept' || event.event === 'reject') return event.attempt === row.attempt;
    return event.args?.attempt === undefined || event.args.attempt === row.attempt;
  });
  return { evidence, events, ...(task.status === 3 && task.attempt === BigInt(row.attempt) && goal.task?.resultHash === row.result_hash && goal.task?.worker?.toLowerCase() === row.owner && goal.settlement ? {settlement:goal.settlement} : {}), superseded: task.attempt > BigInt(row.attempt) || task.status === 0 && task.attempt >= BigInt(row.attempt) };
}

export async function storeTakerExecution(env: Env, row: RunRow, input: unknown, trustedArtifacts: ResultManifest['artifacts'] = []) {
  const execution = executionSchema.parse(input); const config = platformConfig(env); const client = platformClient(config); const owner = row.owner;
  const { task, spec } = await marketTask(env, row.task_id); const now = (await client.getBlock({ blockTag: 'finalized' })).timestamp;
  const parsedOutput = (spec.capability === 'research.web' ? researchOutput : transferOutput).safeParse(execution.output);
  if (!parsedOutput.success) throw new z.ZodError(parsedOutput.error.issues.map(issue => ({ ...issue, path: ['output', ...issue.path] })));
  const body = JSON.parse(row.body);
  // Owner takeover must recover the same paid evidence after detaching the executor.
  if (!trustedArtifacts.length) trustedArtifacts = await externalToolArtifacts(env,owner,row.task_id,row.attempt,body.specHash,execution);
  const current = await getRun(env, row.id);
  if (!current || current.revoked || current.owner !== row.owner || current.executor_id !== row.executor_id || JSON.parse(current.body).hostedAgent !== body.hostedAgent) throw new Error('GRANT_EXPIRED');
  if (current.result_hash) {
    const saved = await reviewResult(env, JSON.parse(current.result_body!),spec);
    const savedTools = saved.artifacts.filter((a: any) => a.mediaType !== 'application/vnd.worknet.identity+json');
    if (hashJson({ output: saved.output, provenance: saved.provenance, artifacts: savedTools }) !== hashJson({ output: parsedOutput.data, provenance: execution.provenance, artifacts: trustedArtifacts })) throw new Error('RESULT_CONFLICT');
    return { hash: current.result_hash, uri: `${config.storageUrl}/objects/${current.result_hash}` };
  }
  if (task.status !== 1 || task.worker.toLowerCase() !== owner || task.attempt.toString() !== row.attempt || now >= task.claimLeaseExpiresAt) throw new Error('CLAIM_REQUIRED');
  if (body.specHash !== task.specHash) throw new Error('SPEC_MISMATCH');
  const { identityArtifact, ...identity } = await identityManifestFields(env, owner);
  const plainResult = { protocol: 'agent-task/0.1', settlementChainId: '10143', taskManager: config.manager.toLowerCase(), taskId: row.task_id, attempt: row.attempt, worker: owner, specHash: task.specHash, output: parsedOutput.data, artifacts: [...trustedArtifacts, ...(identityArtifact ? [identityArtifact] : [])], provenance: execution.provenance, ...identity };
  const result = await protectResult(env,spec,validateResultManifest(plainResult));
  const hash = hashJson(result);
  await env.DB!.prepare('INSERT OR IGNORE INTO objects(hash,body,created_at) VALUES (?,?,?)').bind(hash, canonicalJson(result),Date.now()).run();
  const changed = await env.DB!.prepare("UPDATE platform_runs SET result_hash=?,result_body=? WHERE id=? AND owner=? AND executor_id IS ? AND json_extract(body,'$.hostedAgent') IS ? AND result_hash IS NULL AND revoked=0 RETURNING id").bind(hash,canonicalJson(result),row.id,owner,row.executor_id,body.hostedAgent ?? null).first();
  if (!changed && (await getRun(env,row.id))?.result_hash !== hash) throw new Error('RESULT_CONFLICT');
  return { hash, uri: `${config.storageUrl}/objects/${hash}` };
}

export async function takerApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname.replace('/platform/taker', '');
  const reply = (body: unknown, status = 200) => new Response(serialize(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
  if (!env.DB || !env.PLATFORM || !env.PLATFORM_CONFIG) return reply({ error: '服务未配置。' }, 503);
  try {
    const config = platformConfig(env); const client = platformClient(config);
    // Native harnesses have no Origin. A browser may only write from this platform.
    if (request.method !== 'GET' && request.headers.has('origin') && request.headers.get('origin') !== url.origin) return reply({ error: '请求来源不匹配。' }, 403);
    if (path === '/hosted/catalog' && request.method === 'GET') return reply(hostedCatalog(env));
    if (path === '/agent/start' && request.method === 'POST') return reply(await startAgent(request,env));
    if (path === '/pair' && request.method === 'POST') {
      await platformRate(env, `pair:${request.headers.get('cf-connecting-ip') ?? 'local'}`, 12, 3600000);
      const input = z.object({ id: idSchema, tokenHash: hashSchema, name: z.string().trim().min(1).max(80) }).strict().parse(await platformBody(request));
      await env.DB.prepare('INSERT OR IGNORE INTO platform_executors(id,token_hash,name,expires_at,created_at) VALUES (?,?,?,?,?)').bind(input.id, input.tokenHash, input.name, Date.now() + 600000, Date.now()).run();
      const row = await env.DB.prepare('SELECT * FROM platform_executors WHERE id=?').bind(input.id).first<ExecutorRow>();
      if (!row || row.token_hash !== input.tokenHash || row.name !== input.name) throw new Error('REQUEST_CONFLICT');
      return reply({ id: input.id, expiresAt: row.expires_at, approvalUrl: `${url.origin}/#taker-executors`, instruction: '在接单 > 执行器中输入配对编号并批准。主私钥始终留在钱包。' });
    }
    let executor: ExecutorRow | null = null; let owner: Address | undefined;
    const authorization = request.headers.get('authorization');
    if (authorization) {
      if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) throw new Error('UNAUTHORIZED');
      executor = await env.DB.prepare('SELECT * FROM platform_executors WHERE token_hash=? AND revoked=0 AND expires_at>?').bind(keccak256(stringToHex(authorization.slice(7))), Date.now()).first<ExecutorRow>();
      if (!executor) throw new Error('UNAUTHORIZED');
      if (path === '/me' && request.method === 'GET') return reply({ id: executor.id, name: executor.name, approved: Boolean(executor.approved), owner: executor.owner, expiresAt: executor.expires_at, grant: await agentGrant(env,executor.id) });
      if (!executor.approved || !executor.owner) throw new Error('APPROVAL_REQUIRED');
      owner = executor.owner;
    } else {
      const login = await platformSession(request, env); owner = login?.address;
      if (request.method !== 'GET' && path !== '/pair' && request.headers.get('origin') !== url.origin) return reply({ error: '请在平台页面操作。' }, 403);
    }
    if (request.method !== 'GET') await platformRate(env, `taker-write:${executor?.id ?? owner ?? 'anonymous'}`, 40);
    if (path === '/tasks' && request.method === 'GET') {
      await platformRate(env, `market-read:${request.headers.get('cf-connecting-ip') ?? 'local'}`, 120);
      return reply(await marketList(env,url.searchParams));
    }
    const taskMatch = /^\/tasks\/([1-9][0-9]{0,76})$/.exec(path);
    if (taskMatch && request.method === 'GET') {
      await platformRate(env, `task-read:${request.headers.get('cf-connecting-ip') ?? 'local'}`, 120);
      const { task, spec, goal } = await marketTask(env, taskMatch[1]!); return reply({ taskId: taskMatch[1], task, spec, evidence: goal.evidence, verificationHistory: goal.verificationHistory, events: goal.events });
    }
    if (!owner) throw new Error('UNAUTHORIZED');
    if (path === '/agent/inspect' && request.method === 'POST' && !executor) { const {id}=z.object({id:idSchema}).strict().parse(await platformBody(request)); return reply(await inspectAgent(env,id,owner)); }
    if (path === '/agent/prepare' && request.method === 'POST' && !executor) { const {id}=z.object({id:idSchema}).strict().parse(await platformBody(request)); return reply(await prepareAgent(env,id,owner)); }
    if (path === '/agent/approve' && request.method === 'POST' && !executor) return reply(await approveAgent(request,env,owner));
    if (path === '/executors' && request.method === 'GET' && !executor) {
      const rows = await env.DB.prepare('SELECT json_group_array(json_object(\'id\',id,\'name\',name,\'revoked\',revoked,\'approved\',approved,\'expiresAt\',expires_at)) items FROM platform_executors WHERE owner=?').bind(owner).first<{ items: string }>(); return reply({ executors: await Promise.all(JSON.parse(rows?.items ?? '[]').map(async (e:any)=>{const grant=await agentGrant(env,e.id);const chainRevoked=grant?.approved&&e.revoked?await client.readContract({address:accountEnvironment.DelegationManager,abi:delegationStatusAbi,functionName:'disabledDelegations',args:[hashDelegation(grant.permission)]}).catch(()=>null):null;return {...e,grant,chainRevoked};})) });
    }
    if (path === '/pair/inspect' && request.method === 'POST' && !executor) {
      const { id } = z.object({ id: idSchema }).strict().parse(await platformBody(request));
      if(await env.DB.prepare('SELECT id FROM platform_agent_grants WHERE id=?').bind(id).first())return reply(await inspectAgent(env,id,owner));
      const row = await env.DB.prepare('SELECT id,name,expires_at,owner FROM platform_executors WHERE id=? AND revoked=0 AND expires_at>?').bind(id, Date.now()).first<ExecutorRow>();
      if (!row || row.owner && row.owner !== owner) throw new Error('NOT_FOUND'); const agent=await env.DB.prepare('SELECT signer FROM platform_agent_grants WHERE id=?').bind(id).first<{signer:string}>(); return reply({ id: row.id, name: row.name, expiresAt: row.expires_at, signer:agent?.signer,grant:agent?await agentGrant(env,id):null });
    }
    if (path === '/pair/approve' && request.method === 'POST' && !executor) {
      const { id } = z.object({ id: idSchema }).strict().parse(await platformBody(request));
      if(await env.DB.prepare('SELECT id FROM platform_agent_grants WHERE id=?').bind(id).first())throw new Error('AGENT_GRANT_REQUIRED');
      const row = await env.DB.prepare('UPDATE platform_executors SET owner=?,approved=1,expires_at=? WHERE id=? AND owner IS NULL AND approved=0 AND revoked=0 AND expires_at>? RETURNING id').bind(owner, Date.now() + 86400000, id, Date.now()).first();
      if (!row && !await executorActive(env, id, owner)) throw new Error('PAIR_EXPIRED'); return reply({ id, approved: true });
    }
    if (path === '/executors/revoke' && request.method === 'POST' && !executor) {
      const { id } = z.object({ id: idSchema }).strict().parse(await platformBody(request));
      await env.DB.prepare('UPDATE platform_executors SET revoked=1 WHERE id=? AND owner=?').bind(id, owner).run(); return reply({ revoked: true, detail: '已阻止新的执行器操作；已签名或上链交易无法撤回。已领取任务仍需在期限内处理。' });
    }
    if ((path === '/runs/prepare' && !executor || path === '/agent/take' && executor) && request.method === 'POST') {
      let requested=await platformBody(request);
      const grant=executor?await agentGrant(env,executor.id):null;
      if(executor){
        const {taskId}=z.object({taskId:taskIdSchema}).strict().parse(requested);
        if(!grant?.approved||grant.owner!==owner||grant.validUntil*1000<=Date.now())throw new Error('AGENT_GRANT_REQUIRED');
        const {task}=await marketTask(env,taskId);
        const attempt=task.status===0?task.attempt+1n:task.attempt;
        const hash=keccak256(stringToHex(`worknet/agent-run/1/${executor.id}/${taskId}/${attempt}`)).slice(2,34);
        requested={id:`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20)}`,taskId,executorId:executor.id,mode:'agent'};
      }
      const input = z.object({ id: idSchema, taskId: taskIdSchema, executorId: idSchema.optional(), hostedAgent: hostedAgentSchema.optional(), mode: z.enum(['wallet','sponsored','agent']) }).strict().refine(input => !(input.executorId && input.hostedAgent), 'Choose one runner').parse(requested);
      if(input.mode==='agent'&&!executor)throw new Error('AGENT_GRANT_REQUIRED');
      if (input.executorId && !await executorActive(env, input.executorId, owner)) throw new Error('EXECUTOR_REVOKED');
      const prior = await getRun(env, input.id);
      if (prior) { const b = JSON.parse(prior.body); if (prior.owner !== owner || prior.task_id !== input.taskId || prior.executor_id !== (input.executorId ?? null) || b.mode !== input.mode || b.hostedAgent !== input.hostedAgent) throw new Error('REQUEST_CONFLICT'); await ensureHostedJob(env,prior); return reply(b); }
      const { task, spec } = await marketTask(env, input.taskId); const now = Number((await client.getBlock({ blockTag: 'finalized' })).timestamp);
      if (task.status !== 0 && !(task.status === 1 && task.worker.toLowerCase() === owner)) throw new Error('TASK_UNAVAILABLE');
      if (task.taskDeadline - BigInt(now) < 60n || task.status === 1 && task.claimLeaseExpiresAt - BigInt(now) < 45n) throw new Error('LEASE_EXPIRED');
      if (input.hostedAgent && (!env.HOSTED || !hostedAgents.some(a => a.id === input.hostedAgent && a.capability === spec.capability))) throw new Error('HOSTED_UNAVAILABLE');
      const attempt = task.status === 0 ? task.attempt + 1n : task.attempt;
      if(grant && grant.validUntil <= now+Number(task.claimLeaseSeconds)+30)throw new Error('GRANT_EXPIRED');
      const until = Math.min(grant?.validUntil ?? now + 3600, Number(task.taskDeadline));
      const claim = claimCall(config.manager, input.taskId);
      if (input.mode === 'sponsored' && !isSupportedDelegation(await client.getCode({ address: owner }))) throw new Error('WRONG_DELEGATION');
      const claimPermission = exactPermission(owner, config.sponsor, [claim], `${input.id}:claim`, until);
      const submitPermission = taskSubmissionPermission(owner, config.sponsor, config.manager, BigInt(input.taskId), attempt, input.id, until);
      const body = { ...(input.hostedAgent ? { hostedAgent: input.hostedAgent } : {}), id: input.id, owner, executorId: input.executorId ?? null, taskId: input.taskId, attempt: String(attempt), mode: input.mode, validUntil: until, specHash: task.specHash, spec, claim, claimPermission, submitPermission, claimTypedData: permissionTypedData(claimPermission), submitTypedData: permissionTypedData(submitPermission), authorized: input.mode !== 'sponsored' };
      await env.DB.prepare('INSERT OR IGNORE INTO platform_runs(id,owner,executor_id,task_id,attempt,body,created_at) VALUES (?,?,?,?,?,?,?)').bind(input.id, owner, input.executorId ?? null, input.taskId, String(attempt), serialize(body), Date.now()).run();
      const saved = await getRun(env, input.id); if (!saved) throw new Error('RUN_ALREADY_ASSIGNED');
      if (saved.owner !== owner || saved.task_id !== input.taskId || saved.executor_id !== (input.executorId ?? null) || JSON.parse(saved.body).mode !== input.mode || JSON.parse(saved.body).hostedAgent !== input.hostedAgent) throw new Error('REQUEST_CONFLICT');
      await ensureHostedJob(env, saved); return reply(JSON.parse(saved.body));
    }
    if (path === '/runs/authorize' && request.method === 'POST' && !executor) {
      const input = z.object({ id: idSchema, claimSignature: signatureSchema, submitSignature: signatureSchema }).strict().parse(await platformBody(request));
      const row = await getRun(env, input.id); if (!row || row.owner !== owner) throw new Error('NOT_FOUND'); const body = JSON.parse(row.body);
      if (body.mode !== 'sponsored' || body.validUntil * 1000 <= Date.now()) throw new Error('GRANT_EXPIRED');
      if (row.executor_id && !await executorActive(env, row.executor_id, owner)) throw new Error('EXECUTOR_REVOKED');
      for (const [permission, signature] of [[body.claimPermission,input.claimSignature],[body.submitPermission,input.submitSignature]] as const) {
        if ((await recoverTypedDataAddress({ ...permissionTypedData(permission), signature: signature as Hex })).toLowerCase() !== owner) throw new Error('SIGNATURE_INVALID'); permission.signature = signature;
      }
      body.authorized = true; await env.DB.prepare('UPDATE platform_runs SET body=? WHERE id=? AND owner=? AND revoked=0').bind(serialize(body), row.id, owner).run(); await ensureHostedJob(env, (await getRun(env,row.id))!); return reply({ id: row.id, authorized: true });
    }
    if (path === '/runs/wait' && request.method === 'GET') {
      if (!executor) throw new Error('UNAUTHORIZED');
      const cursor = z.string().regex(/^0x[0-9a-f]{64}$/).optional().parse(url.searchParams.get('cursor') ?? undefined);
      await platformRate(env, `taker-wait:${executor.id}`, 20);
      return reply(await waitForAssignments(() => assignmentSnapshot(env, executor!.id, owner!), cursor, request.signal));
    }
    if (path === '/runs' && request.method === 'GET') {
      const rows = await env.DB.prepare(`SELECT json_group_array(json_object('id',id)) items FROM (SELECT id FROM platform_runs WHERE owner=? ${executor ? 'AND executor_id=?' : ''} ORDER BY created_at DESC LIMIT 60)`).bind(...(executor ? [owner,executor.id] : [owner])).first<{ items: string }>();
      return reply({ runs: await Promise.all((JSON.parse(rows?.items ?? '[]') as { id: string }[]).map(async r => runPublic((await getRun(env,r.id))!, !executor, env))) });
    }
    const match = /^\/runs\/([0-9a-f-]{36})(?:\/(claim|result|submit|revoke|commands|takeover|resume|hosted|tools\/transfers))?$/.exec(path);
    if (match) {
      const row = await getRun(env, match[1]!); if (!row || row.owner !== owner || executor && row.executor_id !== executor.id) throw new Error('NOT_FOUND');
      const operation = match[2]; const body = JSON.parse(row.body);
      if (!operation && request.method === 'GET') { const { task, spec, goal } = await marketTask(env, row.task_id); return reply({ ...await runPublic(row, !executor, env), task, spec, modelUsage: await taskModelUsage(env,row.task_id,row.attempt), ...runHistory(row, goal, task) }); }
      if (operation === 'hosted' && request.method === 'POST' && !executor) { if (!body.hostedAgent) throw new Error('NOT_FOUND'); return reply({ hosted: await ensureHostedJob(env,row) }); }
      if (operation === 'commands' && request.method === 'GET') {
        const rows = await env.DB.prepare("SELECT json_group_array(json_object('id',id,'status',status,'result',json(result))) items FROM platform_commands WHERE owner=? AND id IN (?,?)").bind(owner, `${row.id}:claim`, `${row.id}:submit`).first<{items:string}>();return reply({ commands: JSON.parse(rows?.items ?? '[]') });
      }
      if (operation === 'resume' && request.method === 'POST' && !executor) {
        const { task } = await marketTask(env, row.task_id);
        const now = (await client.getBlock({ blockTag: 'finalized' })).timestamp;
        // Resume the same unclaimed attempt in wallet mode. Never revive a sponsored grant or
        // an executor's access, and never recycle a prior on-chain attempt.
        if (task.status !== 0 || String(task.attempt + 1n) !== row.attempt || task.taskDeadline - now < 60n || row.result_hash) throw new Error('TASK_UNAVAILABLE');
        await env.DB.prepare('UPDATE platform_runs SET revoked=1 WHERE id=? AND owner=?').bind(row.id,owner).run();
        await stopHostedJob(env,row,'已转为手工领取，不再启动托管计算。');
        body.previousHostedAgent = body.hostedAgent ?? body.previousHostedAgent; delete body.hostedAgent;
        body.mode = 'wallet'; body.authorized = true; body.executorId = null; body.validUntil = Number(task.taskDeadline);
        await env.DB.prepare('UPDATE platform_runs SET executor_id=NULL,revoked=0,body=? WHERE id=? AND owner=?').bind(serialize(body), row.id, owner).run();
        return reply({ id: row.id, mode: 'wallet', detail: '已恢复原接单记录；领取仍需当前钱包确认。' });
      }
      if (operation === 'takeover' && request.method === 'POST' && !executor) {
        const { task } = await marketTask(env,row.task_id);
        if (task.status !== 1 || task.worker.toLowerCase() !== owner || String(task.attempt) !== row.attempt) throw new Error('CLAIM_REQUIRED');
        await env.DB.prepare('UPDATE platform_runs SET revoked=1 WHERE id=? AND owner=?').bind(row.id,owner).run();
        await stopHostedJob(env,row,'已由当前钱包接管，平台不再继续生成或提交。');
        body.previousHostedAgent = body.hostedAgent ?? body.previousHostedAgent; delete body.hostedAgent;
        body.mode = 'wallet'; body.authorized = true; body.validUntil = Number(task.claimLeaseExpiresAt);
        await env.DB.prepare('UPDATE platform_runs SET executor_id=NULL,revoked=0,body=? WHERE id=? AND owner=?').bind(serialize(body),row.id,owner).run();
        return reply({ id: row.id, mode: 'wallet', detail: '已停止新的执行器操作，由当前钱包接管；已签名交易仍可能确认。' });
      }
      if (operation === 'revoke' && request.method === 'POST' && !executor) { await env.DB.prepare('UPDATE platform_runs SET revoked=1 WHERE id=? AND owner=?').bind(row.id, owner).run(); await stopHostedJob(env,row,'已停止托管计算与新的平台操作；已发起推理和已签名交易可能仍完成。'); return reply({ revoked: true }); }
      if (request.method !== 'POST') throw new Error('NOT_FOUND');
      if (row.revoked || !body.authorized || body.validUntil * 1000 <= Date.now()) throw new Error('GRANT_EXPIRED');
      if (row.executor_id && !await executorActive(env,row.executor_id,owner)) throw new Error('EXECUTOR_REVOKED');
      if (operation === 'tools/transfers') {
        if (!executor || row.executor_id !== executor.id) throw new Error('UNAUTHORIZED');
        z.object({}).strict().parse(await platformBody(request));
        const {spec}=await marketTask(env,row.task_id);
        if(spec.capability!=='analysis.token-transfers')throw new Error('MPP_UNSUPPORTED_CAPABILITY');
        const purchased=await purchaseTransferTool(env,{owner,taskId:row.task_id,attempt:row.attempt,runId:row.id,executorId:executor.id,specHash:hashJson(spec),input:spec.input as any});
        return reply({output:purchased.output,provenance:purchased.provenance});
      }
      if (operation === 'claim' || operation === 'submit') {
        if (body.mode !== 'sponsored') return reply({ walletRequired: body.mode !== 'agent', agentRequired: body.mode === 'agent', call: operation === 'claim' ? body.claim : submitCall(config.manager,row,config.storageUrl), taskId: row.task_id, attempt: row.attempt });
        return reply(await enqueue(env, owner, `${row.id}:${operation}`, `taker-${operation}`, { runId: row.id }), 202);
      }
      if (operation === 'result') {
        return reply(await storeTakerExecution(env, row, await platformBody(request, 64000)));
      }
    }
    throw new Error('NOT_FOUND');
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = inputIssues(error);
      return reply({ error: `${path.endsWith('/result') ? '交付 JSON' : '请求内容'}格式不正确：${issues.map(i => `${i.field}：${i.message}`).join('；')}`, code: 'INVALID_INPUT', issues }, 400);
    }
    const code = error instanceof z.ZodError ? 'INVALID_INPUT' : String(error).replace(/^Error: /,'');
    const errors: Record<string,string> = { HOSTED_QUOTA_ACTIVE:'你已有 2 轮托管执行尚未结束。可先完成或停止其中一轮，再恢复本计划；尚未触发新的领取。', HOSTED_QUOTA_DAILY:'今日已准备 5 轮托管执行，额度在 UTC 零点重置。可选择手工交付或外部执行器。', HOSTED_QUOTA_GLOBAL:'平台托管队列暂时已满，请稍后恢复原准备记录；尚未触发新的领取。', HOSTED_UNAVAILABLE:'此任务的托管 Agent 尚未可用。', HOSTED_MODEL_UNAVAILABLE:'研究模型当前不可用，请稍后重试。', UNAUTHORIZED:'请连接钱包或有效的执行器。', APPROVAL_REQUIRED:'执行器尚未获得用户批准。', PAIR_EXPIRED:'配对已失效，请重新发起。', EXECUTOR_REVOKED:'执行器已撤销或到期。', GRANT_EXPIRED:'任务授权已撤销或到期。', AGENT_ACCOUNT_MISMATCH:'当前登录账户与此 Agent 绑定的账户不同。请使用开户时的原通行密钥登录，不要重新创建账户。', AGENT_GRANT_REQUIRED:'请先完成 Agent 的通行密钥授权；普通配对不能自主领取任务。', AUTHORIZATION_INVALID:'账户激活授权已失效，请在首次设置页面重新确认。', WRONG_DELEGATION:'钱包尚未启用兼容智能账户，请使用钱包确认模式。', TASK_UNAVAILABLE:'任务已被领取或结束，请刷新。', CLAIM_REQUIRED:'仅当前领取者可在有效租约内提交这一轮结果。', RUN_ALREADY_ASSIGNED:'该轮任务已有执行记录，请在我的接单中恢复。', RESULT_CONFLICT:'本轮结果已固定，请恢复原交付，不要替换内容。' };
    Object.assign(errors,{MPP_AWAITING_FINALITY:'工具付款正在等待链上最终确认，请保留同一执行编号重试。',MPP_PREVIOUS_PAYMENT_PENDING:'前一笔工具付款尚未确认，请稍后重试原执行。',MPP_TASK_INACTIVE:'任务未领取、已结束或授权失效，不能购买工具。',MPP_EXECUTOR_INACTIVE:'执行器已撤销、到期或与任务不匹配。',MPP_NOT_CONFIGURED:'平台工具采购尚未配置。',MPP_BUDGET_LIMIT:'平台工具额度不足，请稍后重试原任务。',MPP_RESULT_MISMATCH:'交付与已采购的工具结果不一致，请上传原工具输出及来源记录。',MPP_UNSUPPORTED_CAPABILITY:'本接口仅支持当前任务指定的链上转账分析。'});
    return reply({ error: errors[code] ?? '操作未完成，请刷新状态并重试原操作。', code: /^[A-Z_]+$/.test(code) ? code : 'REQUEST_FAILED' }, ['MPP_AWAITING_FINALITY','MPP_PREVIOUS_PAYMENT_PENDING','MPP_UNAVAILABLE'].includes(code) ? 503 : /NOT_FOUND/.test(code) ? 404 : code === 'UNAUTHORIZED' ? 401 : /REVOKED|APPROVAL_REQUIRED|GRANT_EXPIRED/.test(code) ? 403 : /CONFLICT|ASSIGNED|UNAVAILABLE/.test(code) ? 409 : code === 'RATE_LIMIT' || code.startsWith('HOSTED_QUOTA') ? 429 : 400);
  }
}
