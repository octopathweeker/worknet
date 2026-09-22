import {initializeAgent,renewAgent,configuredClient,loadConfig} from '../packages/taker/src/config.js';
import {agentSessionPermission,disablePermission} from '@agent-task/accounts';
import {privateKeyToAccount} from 'viem/accounts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TakerClient} from '../packages/taker/src/client.js';
import {executeRun,watchAssignments} from '../packages/taker/src/watch.js';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {createPublicClient,createWalletClient,http,erc20Abi,bytesToHex,keccak256,stringToHex,encodeFunctionData,type Address,type Hex} from 'viem';
import {monadTestnet} from 'viem/chains';
import {mnemonicToAccount} from 'viem/accounts';
import {factoryAbi,delegatedImplementation,permissionTypedData,redeemPermission} from '@agent-task/accounts';
import {taskManagerAbi,requesterVaultAbi} from '@agent-task/contracts';
import {PlatformCoordinator} from '../apps/object-store/src/platform-coordinator.js';
import {platformApi} from '../apps/object-store/src/platform-api.js';
import {takerApi} from '../apps/object-store/src/taker-api.js';
import type {Env} from '../apps/object-store/src/index.js';

test('external taker permissions, isolated uploads, revoke/takeover and durable sponsorship settle to the user', {timeout:150000}, async()=>{
 const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
 const anvil=spawn('.tools/foundry/anvil',['--network','monad','--hardfork','MonadNine','--chain-id','10143','--port',String(port),'--silent'],{stdio:'ignore'});
 const rpc=`http://127.0.0.1:${port}`;const nativeFetch=globalThis.fetch;
 const client=createPublicClient({chain:monadTestnet,transport:http(rpc),pollingInterval:50});
 const accounts=Array.from({length:6},(_,addressIndex)=>mnemonicToAccount('test test test test test test test test test test test junk',{addressIndex}));const [sponsor,operator,platformWorker,requester,taker]=accounts as [typeof accounts[0],typeof accounts[0],typeof accounts[0],typeof accounts[0],typeof accounts[0]];
 const wallets=accounts.map(account=>createWalletClient({chain:monadTestnet,account,transport:http(rpc)}));
 const db=new DatabaseSync(':memory:');db.exec(readFileSync('apps/object-store/schema.sql','utf8'));db.exec(readFileSync('apps/object-store/platform-schema.sql','utf8'));
 try{
  for(let i=0;;i++){try{await client.getChainId();break;}catch{if(i>40)throw new Error('startup');await new Promise(r=>setTimeout(r,100));}}
  const raw=async(method:string,params:unknown[])=>{const response=await nativeFetch(rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const value=await response.json() as any;if(value.error)throw new Error(JSON.stringify(value.error));return value.result;};
  const fixture=JSON.parse(readFileSync('tests/fixtures/7702-deployments.json','utf8'));for(const entry of Object.values(fixture.contracts) as any[])await raw('anvil_setCode',[entry.address,entry.code]);
  await raw('anvil_setCode',[taker!.address,`0xef0100${delegatedImplementation.slice(2)}`]);
  async function deploy(name:string,args:unknown[]=[]){const artifact=JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`,'utf8'));const hash=await wallets[0]!.deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object,args});return (await client.waitForTransactionReceipt({hash})).contractAddress!;}
  const testJudges=['0x1111111111111111111111111111111111111111','0x2222222222222222222222222222222222222222'];
  const token=await deploy('MockUSDC');const manager=await deploy('TaskManager',[token,testJudges,1]);const factory=await deploy('RequesterVaultFactory',[manager,token]);
  const receipt=async(hash:Hex)=>{const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r;};
  await receipt(await wallets[0]!.writeContract({address:token,abi:[...erc20Abi,{type:'function',name:'mint',stateMutability:'nonpayable',inputs:[{type:'address',name:'to'},{type:'uint256',name:'amount'}],outputs:[]}],functionName:'mint',args:[requester!.address,1000000n]}));
  await receipt(await wallets[3]!.writeContract({address:factory,abi:factoryAbi,functionName:'createVault',args:[requester!.address]}));const vault=await client.readContract({address:factory,abi:factoryAbi,functionName:'vaultOf',args:[requester!.address]});
  await receipt(await wallets[3]!.writeContract({address:token,abi:erc20Abi,functionName:'approve',args:[vault,500000n]}));await receipt(await wallets[3]!.writeContract({address:vault,abi:requesterVaultAbi,functionName:'deposit',args:[500000n]}));
  await receipt(await wallets[3]!.writeContract({address:vault,abi:requesterVaultAbi,functionName:'authorizeAgent',args:[operator!.address,{validAfter:0n,validUntil:(await client.getBlock()).timestamp+86400n,maxPerTask:200000n,maxTotalCommitment:500000n}]}));
  globalThis.fetch=async(input,init)=>{if(!String(input).startsWith('https://taker-rpc.test'))return nativeFetch(input,init);const p=JSON.parse(String(init?.body));if(p.method==='eth_call'&&p.params[1]==='finalized')p.params[1]='latest';if(p.method==='eth_getBlockByNumber'&&p.params[0]==='finalized')p.params[0]='latest';return nativeFetch(rpc,{...init,body:JSON.stringify(p)});};
  const memory=new Map<string,unknown>();let crash=false,crashed=false;
  const ctx={storage:{async get(key:string){return structuredClone(memory.get(key));},async list(o:any){return new Map([...memory.entries()].filter(([k])=>k.startsWith(o.prefix)&&(!o.startAfter||k>o.startAfter)).sort().slice(0,o.limit));},async put(key:string|Record<string,unknown>,value?:unknown){const entries=typeof key==='string'?[[key,value] as const]:Object.entries(key);if(crash&&entries.some(([k,v])=>k.startsWith('tx:sponsor:taker-claim:')&&(v as any)?.status==='confirmed')){crash=false;crashed=true;throw new Error('simulated death after external claim mined');}for(const [k,v]of entries)memory.set(k,structuredClone(v));},async delete(k:string){memory.delete(k);},async getAlarm(){return null;},async setAlarm(_value:number){}}};
  let coordinator:PlatformCoordinator;
  const env:Env={PLATFORM_CONFIG:JSON.stringify({chainId:10143,manager,token,factory,operator:operator!.address,worker:platformWorker!.address,sponsor:sponsor!.address,rpcUrl:'https://taker-rpc.test',storageUrl:'https://platform.test',deploymentBlock:'0'}),PLATFORM_OPERATOR_KEY:bytesToHex(operator!.getHdKey().privateKey!),PLATFORM_WORKER_KEY:bytesToHex(platformWorker!.getHdKey().privateKey!),PLATFORM_SPONSOR_KEY:bytesToHex(sponsor!.getHdKey().privateKey!),PLATFORM:{idFromName:()=>1,get:()=>({fetch:(u:string,i:RequestInit)=>coordinator.fetch(new Request(u,i))})}as any,DB:{prepare(sql){let args:SQLInputValue[]=[];return{bind(...v){args=v as SQLInputValue[];return this;},async first<T>(){return(db.prepare(sql).get(...args)??null)as T|null;},async run(){return db.prepare(sql).run(...args);}};}}};
  coordinator=new PlatformCoordinator(ctx as any,env);
  async function call(path:string,body?:unknown,cookie='',bearer=''){const request=new Request(`https://platform.test/platform/${path}`,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{origin:'https://platform.test','content-type':'application/json',cookie,...(bearer?{authorization:`Bearer ${bearer}`}:{})}});return path.startsWith('taker/')?takerApi(request,env):platformApi(request,env);}
  async function ok(path:string,body?:unknown,cookie='',bearer=''){const r=await call(path,body,cookie,bearer);const value=await r.json() as any;assert(r.ok,JSON.stringify(value));return value;}
  async function login(i:number){const account=accounts[i]!;const c=await ok('auth/challenge',{address:account.address});const r=await call('auth/verify',{id:c.id,signature:await account.signMessage({message:c.message})});assert(r.ok);return r.headers.get('set-cookie')!.split(';')[0]!;}
  const rCookie=await login(3),tCookie=await login(4);const tokens=['aa'.repeat(32),'bb'.repeat(32)];const exIds=[crypto.randomUUID(),crypto.randomUUID()];
  for(let i=0;i<2;i++){await ok('taker/pair',{id:exIds[i],tokenHash:keccak256(stringToHex(tokens[i]!)),name:`Harness ${i}`});assert.equal((await call('taker/runs',undefined,'',tokens[i])).status,403);await ok('taker/pair/approve',{id:exIds[i]},tCookie);assert.equal((await call('taker/pair/approve',{id:exIds[i]},rCookie)).status,400);}
  const goalIds=[];for(let i=0;i<2;i++){const id=crypto.randomUUID();goalIds.push(id);await ok('plans',{id,goal:`开放接单独立执行器测试任务 ${i}`,kind:'analysis',execution:'market',reward:'50000',fromBlock:'1',toBlock:'2'},rCookie);await ok('launch',{id:crypto.randomUUID(),goalId:id},rCookie);await coordinator.alarm();}
  await coordinator.alarm();const market=await ok('taker/tasks');assert.equal(market.tasks.length,2);for(const entry of market.tasks)assert.equal(Number((await client.readContract({address:manager,abi:taskManagerAbi,functionName:'getTask',args:[BigInt(entry.taskId)]})).status),0,'platform worker must abstain');
  const runId=crypto.randomUUID(),taskId='1';const prepared=await ok('taker/runs/prepare',{id:runId,taskId,executorId:exIds[0],mode:'sponsored'},tCookie);
  assert.equal((await call('taker/runs/prepare',{id:crypto.randomUUID(),taskId,executorId:exIds[1],mode:'sponsored'},tCookie)).status,409);
  await ok('taker/runs/authorize',{id:runId,claimSignature:await taker!.signTypedData(prepared.claimTypedData),submitSignature:await taker!.signTypedData(prepared.submitTypedData)},tCookie);
  assert.equal((await call(`taker/runs/${runId}`,undefined,'',tokens[1])).status,404);
  assert.equal((await call('setup',{id:crypto.randomUUID(),amount:'50000'},'',tokens[0])).status,401,'executor must never authorize requester budgets');
  await ok(`taker/runs/${runId}/claim`,{},'',tokens[0]);await ok(`taker/runs/${runId}/claim`,{},'',tokens[0]);crash=true;await coordinator.alarm();assert(crashed);coordinator=new PlatformCoordinator(ctx as any,env);db.exec("UPDATE platform_commands SET result=json_remove(result,'$.retryAt') WHERE status='processing'");await coordinator.alarm();
  const task=await client.readContract({address:manager,abi:taskManagerAbi,functionName:'getTask',args:[1n]});assert.equal(task.worker.toLowerCase(),taker!.address.toLowerCase());assert.equal(task.attempt,1n);
  const progressPath=`taker/runs/${runId}/progress`;
  const update={id:crypto.randomUUID(),summary:'已完成前半区块核对，正在统计剩余转账。',percent:50};
  assert.equal((await call(progressPath,update,'',tokens[1])).status,404,'another executor cannot report progress');
  assert.equal((await call(progressPath,{...update,percent:101},'',tokens[0])).status,400);
  const report=await ok(progressPath,update,'',tokens[0]);
  assert.deepEqual(await ok(progressPath,update,'',tokens[0]),report,'retry preserves timestamp and creates no duplicate');
  assert.equal((await call(progressPath,{...update,summary:'changed'},'',tokens[0])).status,409);
  await coordinator.alarm();
  const requesterGoals=await ok('goals',undefined,rCookie);
  assert.deepEqual(requesterGoals.goals.find((g:any)=>g.taskId===taskId).progress,[report]);
  assert.equal((await ok('goals',undefined,tCookie)).goals.length,0,'a different requester sees no reports');
  assert.deepEqual((await ok(`taker/runs/${runId}`,undefined,'',tokens[0])).progress,[report]);
  assert(!JSON.stringify(await ok(`taker/tasks/${taskId}`)).includes(update.summary),'progress must not leak through the public market');
  const permission={...prepared.submitPermission,signature:await taker!.signTypedData(prepared.submitTypedData)};
  const submit=(id:bigint,attempt:bigint,target=manager)=>({target,value:0n,callData:encodeFunctionData({abi:taskManagerAbi,functionName:'submitResult',args:[id,attempt,`0x${'12'.repeat(32)}`,'https://platform.test/objects/test']})});
  for(const bad of [submit(2n,1n),submit(1n,2n),submit(1n,1n,token),{...submit(1n,1n),value:1n},{...submit(1n,1n),callData:encodeFunctionData({abi:taskManagerAbi,functionName:'claimTask',args:[2n]})}])await assert.rejects(client.call({...redeemPermission(permission,[bad]),account:sponsor}),/revert/i);
  const expired={...permission,caveats:prepared.submitPermission.caveats.map((c:any)=>({...c}))};const wrongChain=await taker!.signTypedData({...permissionTypedData(expired),domain:{...permissionTypedData(expired).domain,chainId:1}});await assert.rejects(client.call({...redeemPermission({...expired,signature:wrongChain},[submit(1n,1n)]),account:sponsor}),/revert/i);
  const execution={output:{eventCount:'0',totalAmountBaseUnits:'0'},provenance:{toolVersion:'external-test/1',sourceChainId:'10143',blockRange:{fromBlock:'1',toBlock:'2',toBlockHash:(await client.getBlock({blockNumber:2n})).hash}}};
  const invalidUpload=await call(`taker/runs/${runId}/result`,{output:execution.output,provenance:{mode:'llm',sources:[{url:'https://docs.monad.xyz/',fetchedAt:'2026-09-19'}]}},'',tokens[0]);
  assert.equal(invalidUpload.status,400);const invalidBody=await invalidUpload.json() as any;assert.equal(invalidBody.code,'INVALID_INPUT');assert(invalidBody.issues.some((i:any)=>i.field==='provenance.toolVersion'));assert.match(invalidBody.error,/provenance.sources.0.contentHash/);assert.equal(db.prepare('SELECT result_hash FROM platform_runs WHERE id=?').get(runId)!.result_hash,null,'rejected format must not freeze this attempt');
  const upload=await ok(`taker/runs/${runId}/result`,execution,'',tokens[0]);assert.equal((await ok(`taker/runs/${runId}/result`,execution,'',tokens[0])).hash,upload.hash);
  assert.equal((await call(progressPath,{...update,id:crypto.randomUUID()},'',tokens[0])).status,400,'progress closes once the result is fixed');
  assert.equal((await call(`taker/runs/${runId}/result`,{...execution,output:{eventCount:'1',totalAmountBaseUnits:'0'}},'',tokens[0])).status,409);assert.equal((await call(`taker/runs/${runId}/result`,execution,'',tokens[1])).status,404);
  await ok(`taker/runs/${runId}/submit`,{},'',tokens[0]);await coordinator.alarm();for(let i=0;i<5;i++)await coordinator.alarm();assert.equal((await client.readContract({address:manager,abi:taskManagerAbi,functionName:'getTask',args:[1n]})).status,3);
  db.prepare("UPDATE platform_goals SET body=json_set(body,'$.events',json('[]')) WHERE json_extract(body,'$.taskId')='1'").run();
  const refreshed=await ok(`taker/runs/${runId}`,undefined,'',tokens[0]);assert(refreshed.events.some((e:any)=>e.event==='TaskSettled'),'finalized payment remains discoverable after the goal stops ticking');
  assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[taker!.address]}),50000n);assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[platformWorker!.address]}),0n);
  const secondId=crypto.randomUUID();const second=await ok('taker/runs/prepare',{id:secondId,taskId:'2',executorId:exIds[1],mode:'wallet'},tCookie);await ok(`taker/runs/${secondId}/revoke`,{},tCookie);
  assert.equal((await call(`taker/runs/${secondId}/resume`,{},rCookie)).status,404,'another requester cannot resume a taker run');
  assert.equal((await call(`taker/runs/${secondId}/resume`,{},'',tokens[1])).status,403,'executor cannot revive a revoked grant');
  await ok(`taker/runs/${secondId}/resume`,{},tCookie);
  const resumed=await ok(`taker/runs/${secondId}`,undefined,tCookie);assert.equal(resumed.revoked,false);assert.equal(resumed.executorId,null);assert.equal(resumed.id,secondId);assert.equal(resumed.mode,'wallet');
  assert.equal(db.prepare('SELECT count(*) AS n FROM platform_runs WHERE task_id=? AND owner=?').get('2',taker!.address.toLowerCase())!.n,1,'recovery must retain the same attempt record');
  assert.equal((await call(`taker/runs/${secondId}/result`,execution,'',tokens[1])).status,404,'old executor stays detached');
  await receipt(await wallets[4]!.sendTransaction({to:second.claim.target,data:second.claim.callData,value:0n}));
  assert.equal((await call(`taker/runs/${secondId}/resume`,{},tCookie)).status,409,'claimed attempt cannot be reset to unclaimed');
  await ok('taker/executors/revoke',{id:exIds[1]},tCookie);assert.equal((await call(`taker/runs/${secondId}/result`,execution,'',tokens[1])).status,401);
  await ok(`taker/runs/${secondId}/takeover`,{},tCookie);await ok(`taker/runs/${secondId}/result`,execution,tCookie);const ordinary=await ok(`taker/runs/${secondId}/submit`,{},tCookie);assert(ordinary.walletRequired);await receipt(await wallets[4]!.sendTransaction({to:ordinary.call.target,data:ordinary.call.callData,value:0n}));for(let i=0;i<5;i++)await coordinator.alarm();
  assert.equal(await client.readContract({address:manager,abi:taskManagerAbi,functionName:'totalEscrowed'}),0n);assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[taker!.address]}),100000n);
  // The same real chain flow through long polling and the built-in local runner.
  const thirdGoal=crypto.randomUUID();
  await ok('plans',{id:thirdGoal,goal:'长轮询自动接收并执行链上转账分析任务',kind:'analysis',execution:'market',reward:'50000',fromBlock:'1',toBlock:'2'},rCookie);
  await ok('launch',{id:crypto.randomUUID(),goalId:thirdGoal},rCookie);await coordinator.alarm();await coordinator.alarm();
  const watchedId=crypto.randomUUID();const watched=await ok('taker/runs/prepare',{id:watchedId,taskId:'3',executorId:exIds[0],mode:'sponsored'},tCookie);
  const routedFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    const url=String(input);
    if(url==='https://platform.test/platform/config')return new Response(JSON.stringify({manager,token,rpcWalletUrl:'https://taker-rpc.test'}));
    if(url.startsWith('https://platform.test/platform/taker/'))return takerApi(new Request(url,init),env);
    return routedFetch(input,init);
  };
  const stop=new AbortController(),directory=await mkdtemp(join(tmpdir(),'taker-e2e-watch-'));
  const takerClient=new TakerClient('https://platform.test',tokens[0],stop.signal);
  const idle=await takerClient.wait();assert.equal(idle.runs.length,0,'prepared but unsigned runs are not work');
  const events:any[]=[];let tick:Promise<void>|undefined;
  const timer=setInterval(()=>{if(!tick)tick=coordinator.alarm().finally(()=>{tick=undefined;});},200);
  const timeout=setTimeout(()=>stop.abort(new Error('watch integration timeout')),30000);
  const pending=watchAssignments({signal:stop.signal,wait:cursor=>takerClient.wait(cursor??idle.cursor),execute:id=>executeRun(takerClient,id,directory),log:event=>{events.push(event);if(event.state==='submitted')stop.abort();}});
  try{
    await ok('taker/runs/authorize',{id:watchedId,claimSignature:await taker!.signTypedData(watched.claimTypedData),submitSignature:await taker!.signTypedData(watched.submitTypedData)},tCookie);
    await pending;
    assert(events.some(e=>e.runId===watchedId&&e.state==='submitted'),JSON.stringify(events));
    const reports=(await ok(`taker/runs/${watchedId}`,undefined,tCookie)).progress;
    assert.equal(reports.length,2,'built-in runner reports real execution milestones');
    assert.equal(reports[0].percent,100);
  }finally{stop.abort();await pending;clearInterval(timer);clearTimeout(timeout);await tick;globalThis.fetch=routedFetch;await rm(directory,{recursive:true,force:true});}
  for(let i=0;i<5;i++)await coordinator.alarm();
  assert.equal((await client.readContract({address:manager,abi:taskManagerAbi,functionName:'getTask',args:[3n]})).status,3);
  assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[taker!.address]}),150000n,'long-poll run settled to the taker');
  // First human approval -> funded local execution key -> autonomous claims and submissions.
  const agentDirectory=await mkdtemp(join(tmpdir(),'worknet-agent-account-'));const originalConfig=process.env.WORKNET_TAKER_CONFIG;
  process.env.WORKNET_TAKER_CONFIG=join(agentDirectory,'agent.json');
  globalThis.fetch=async(input,init)=>{
    const url=String(input);
    if(url==='https://platform.test/platform/config')return new Response(JSON.stringify({manager,token,storageUrl:'https://platform.test',rpcWalletUrl:'https://taker-rpc.test'}));
    if(url.startsWith('https://platform.test/platform/taker/'))return takerApi(new Request(url,init),env);
    return routedFetch(input,init);
  };
  try{
    const initial=await initializeAgent('https://platform.test','Autonomous Agent');
    const again=await initializeAgent('https://platform.test','Autonomous Agent');assert.equal(initial.id,again.id);
    const local=await loadConfig();assert(local.executionKey);const executionAccount=privateKeyToAccount(local.executionKey);
    assert.equal(initial.signer,executionAccount.address.toLowerCase());
    assert(!JSON.stringify(initial).includes(local.executionKey));
    const root=accounts[5]!;const rootCookie=await login(5);await raw('anvil_setBalance',[root.address,'0x0']);
    assert.equal((await call('taker/pair/approve',{id:initial.id},rootCookie)).status,400,'legacy approval cannot activate autonomous authority');
    const grant=await ok('taker/agent/prepare',{id:initial.id},rootCookie);
    assert.equal(grant.activationRequired,true);assert.equal(grant.maxCalls,200);
    const auth=await root.signAuthorization!({chainId:10143,contractAddress:delegatedImplementation,nonce:grant.nonce});
    const authorization={address:auth.address,chainId:auth.chainId,nonce:auth.nonce,r:auth.r,s:auth.s,yParity:auth.yParity};
    const signature=await root.signTypedData(grant.typedData);
    assert.equal((await call('taker/agent/approve',{id:initial.id,signature,authorization:{...authorization,chainId:1}},rootCookie)).status,400);
    await ok('taker/agent/approve',{id:initial.id,signature,authorization},rootCookie);
    assert.equal((await call('taker/agent/prepare',{id:initial.id},rCookie)).status,400,'another owner cannot take the grant');
    await assert.rejects(renewAgent(),/still active/);
    const autonomous=await configuredClient();const status=await autonomous.status();assert.equal(status.gasBalanceMON,'0');assert.equal(status.rewardAddress,root.address.toLowerCase());
    assert.equal(status.accountUrl,initial.approvalUrl);
    const reopened=await ok('taker/agent/inspect',{id:initial.id},rootCookie);assert.equal(reopened.state,'active');assert.equal(reopened.signer,initial.signer);assert.equal(reopened.grant.owner,root.address.toLowerCase());
    const mismatch=await call('taker/agent/inspect',{id:initial.id},rCookie);assert.equal(mismatch.status,400);const wrongOwner=await mismatch.json() as any;assert.equal(wrongOwner.code,'AGENT_ACCOUNT_MISMATCH');assert.equal(wrongOwner.grant,undefined);
    db.prepare('UPDATE platform_executors SET expires_at=0 WHERE id=?').run(initial.id);
    const expiredView=await ok('taker/agent/inspect',{id:initial.id},rootCookie);assert.equal(expiredView.state,'expired');assert.equal(expiredView.grant.permission.signature,signature,'inspection must not replace or renew the grant');
    assert.equal((await ok('taker/pair/inspect',{id:initial.id},rootCookie)).state,'expired','old pairing lookup must reopen Agent account records');
    const unavailable=await autonomous.status();assert.equal(unavailable.state,'access-unavailable');assert.equal(unavailable.accountUrl,initial.approvalUrl);assert.equal(unavailable.authorized,false);
    await assert.rejects(autonomous.take('4'),/UNAUTHORIZED/);
    db.prepare('UPDATE platform_executors SET expires_at=? WHERE id=?').run(grant.validUntil*1000,initial.id);

    for(let i=0;i<2;i++){const id=crypto.randomUUID();await ok('plans',{id,goal:`自主 Agent 接单与撤销验证任务 ${i}`,kind:'analysis',execution:'market',reward:'50000',fromBlock:'1',toBlock:'2'},rCookie);await ok('launch',{id:crypto.randomUUID(),goalId:id},rCookie);await coordinator.alarm();await coordinator.alarm();}
    const taken=await autonomous.take('4');assert.equal((await autonomous.take('4')).id,taken.id);
    assert.equal(taken.mode,'agent');assert.equal(taken.owner,root.address.toLowerCase());
    await assert.rejects(autonomous.claim(taken.id),/GAS_REQUIRED/);
    await raw('anvil_setBalance',[executionAccount.address,'0x6f05b59d3b20000']);
    const nonceBefore=await client.getTransactionCount({address:executionAccount.address});
    await autonomous.claim(taken.id);assert.equal((await client.readContract({address:manager,abi:taskManagerAbi,functionName:'getTask',args:[4n]})).worker.toLowerCase(),root.address.toLowerCase());
    await autonomous.claim(taken.id);assert.equal(await client.getTransactionCount({address:executionAccount.address}),nonceBefore+1,'claim retry must not spend twice');
    assert.equal(await client.getBalance({address:root.address}),0n,'the Mera root need not be funded for Agent operation');
    const approved={...grant.permission,signature};
    const forbidden=[{target:token,value:0n,callData:encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[executionAccount.address,1n]})},{target:manager,value:1n,callData:encodeFunctionData({abi:taskManagerAbi,functionName:'claimTask',args:[5n]})},{target:manager,value:0n,callData:encodeFunctionData({abi:taskManagerAbi,functionName:'cancelTask',args:[5n]})}];
    for(const bad of forbidden)await assert.rejects(client.call({...redeemPermission(approved,[bad]),account:executionAccount}),/revert/i);
    await assert.rejects(client.call({...redeemPermission(approved,[{target:manager,value:0n,callData:encodeFunctionData({abi:taskManagerAbi,functionName:'claimTask',args:[5n]})}]),account:sponsor}),/revert/i,'a different signer cannot redeem the public grant');
    const freshClient=await configuredClient();const completed=await executeRun(freshClient,taken.id,agentDirectory);assert.equal(completed.state,'submitted');assert.equal((await freshClient.status()).remainingCalls,198);
    for(let i=0;i<5;i++)await coordinator.alarm();
    assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[root.address]}),50000n,'reward goes to Mera root');
    assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[executionAccount.address]}),0n);
    const next=await freshClient.take('5');
    const expired=agentSessionPermission(root.address,executionAccount.address,manager,'expired-agent',Number((await client.getBlock()).timestamp)-1);expired.signature=await root.signTypedData(permissionTypedData(expired));
    await assert.rejects(client.call({...redeemPermission(expired,[{target:manager,value:0n,callData:encodeFunctionData({abi:taskManagerAbi,functionName:'claimTask',args:[5n]})}]),account:executionAccount}),/revert/i);
    await raw('anvil_setBalance',[root.address,'0x16345785d8a0000']);await receipt(await wallets[5]!.sendTransaction(disablePermission(approved)));
    await assert.rejects(freshClient.claim(next.id),/AGENT_GRANT_REVOKED/i,'on-chain revocation prevents claims even while the API token remains active');
    await ok('taker/executors/revoke',{id:initial.id},rootCookie);await assert.rejects(freshClient.take('5'),/UNAUTHORIZED/);
    const revokedView=await ok('taker/agent/inspect',{id:initial.id},rootCookie);assert.equal(revokedView.state,'revoked');assert.equal(revokedView.grant.owner,root.address.toLowerCase());
    const renewed=await renewAgent();assert.notEqual(renewed.id,initial.id);assert.equal(renewed.signer,initial.signer);assert.equal((await renewAgent()).id,renewed.id);assert.equal((await loadConfig()).executionKey,local.executionKey);assert.equal((await (await configuredClient()).status()).approved,false,'renewal must wait for a new human approval');
  }finally{globalThis.fetch=routedFetch;if(originalConfig===undefined)delete process.env.WORKNET_TAKER_CONFIG;else process.env.WORKNET_TAKER_CONFIG=originalConfig;await rm(agentDirectory,{recursive:true,force:true});}
  db.prepare('UPDATE platform_executors SET expires_at=0').run();assert.equal((await call('taker/runs',undefined,'',tokens[0])).status,401);
 }finally{globalThis.fetch=nativeFetch;db.close();anvil.kill('SIGTERM');}
});
