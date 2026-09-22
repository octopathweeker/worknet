import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {readFileSync} from 'node:fs';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {createPublicClient,createWalletClient,http,erc20Abi,bytesToHex,keccak256,stringToHex,encodeFunctionData,type Address,type Hex} from 'viem';
import {monadTestnet} from 'viem/chains';
import {mnemonicToAccount} from 'viem/accounts';
import {factoryAbi,delegatedImplementation,permissionTypedData,redeemPermission} from '@agent-task/accounts';
import {taskManagerAbi,requesterVaultAbi} from '@agent-task/contracts';
import {HostedRunner} from '../apps/object-store/src/hosted-runner.js';
import {PlatformCoordinator} from '../apps/object-store/src/platform-coordinator.js';
import {platformApi} from '../apps/object-store/src/platform-api.js';
import {takerApi} from '../apps/object-store/src/taker-api.js';
import type {Env} from '../apps/object-store/src/index.js';

test('retired hosted entry points reject new runs while already-claimed legacy actors drain safely', {timeout:150000}, async()=>{
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
  for(const account of [accounts[4]!,accounts[5]!])await raw('anvil_setCode',[account.address,`0xef0100${delegatedImplementation.slice(2)}`]);
  async function deploy(name:string,args:unknown[]=[]){const artifact=JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`,'utf8'));const hash=await wallets[0]!.deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object,args});return (await client.waitForTransactionReceipt({hash})).contractAddress!;}
  const testJudges=['0x1111111111111111111111111111111111111111','0x2222222222222222222222222222222222222222'];
const token=await deploy('MockUSDC');const manager=await deploy('TaskManager',[token,testJudges,1]);const factory=await deploy('RequesterVaultFactory',[manager,token]);
  const receipt=async(hash:Hex)=>{const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r;};
  await receipt(await wallets[0]!.writeContract({address:token,abi:[...erc20Abi,{type:'function',name:'mint',stateMutability:'nonpayable',inputs:[{type:'address',name:'to'},{type:'uint256',name:'amount'}],outputs:[]}],functionName:'mint',args:[requester!.address,1000000n]}));
  await receipt(await wallets[3]!.writeContract({address:factory,abi:factoryAbi,functionName:'createVault',args:[requester!.address]}));const vault=await client.readContract({address:factory,abi:factoryAbi,functionName:'vaultOf',args:[requester!.address]});
  await receipt(await wallets[3]!.writeContract({address:token,abi:erc20Abi,functionName:'approve',args:[vault,500000n]}));await receipt(await wallets[3]!.writeContract({address:vault,abi:requesterVaultAbi,functionName:'deposit',args:[500000n]}));
  await receipt(await wallets[3]!.writeContract({address:vault,abi:requesterVaultAbi,functionName:'authorizeAgent',args:[operator!.address,{validAfter:0n,validUntil:(await client.getBlock()).timestamp+86400n,maxPerTask:200000n,maxTotalCommitment:500000n}]}));
  const sourceText='Transaction batching and gas sponsorship are supported by delegated accounts.';
  globalThis.fetch=async(input,init)=>{if(String(input).startsWith('https://docs.monad.xyz/'))return new Response(sourceText);if(!String(input).startsWith('https://taker-rpc.test'))return nativeFetch(input,init);const p=JSON.parse(String(init?.body));if(p.method==='eth_call'&&p.params[1]==='finalized')p.params[1]='latest';if(p.method==='eth_getBlockByNumber'&&p.params[0]==='finalized')p.params[0]='latest';return nativeFetch(rpc,{...init,body:JSON.stringify(p)});};
  const memory=new Map<string,unknown>();let crash=false,crashed=false;
  const ctx={storage:{async get(key:string){return structuredClone(memory.get(key));},async list(o:any){return new Map([...memory.entries()].filter(([k])=>k.startsWith(o.prefix)&&(!o.startAfter||k>o.startAfter)).sort().slice(0,o.limit));},async put(key:string|Record<string,unknown>,value?:unknown){const entries=typeof key==='string'?[[key,value] as const]:Object.entries(key);if(crash&&entries.some(([k,v])=>k.startsWith('tx:sponsor:taker-claim:')&&(v as any)?.status==='confirmed')){crash=false;crashed=true;throw new Error('simulated death after external claim mined');}for(const [k,v]of entries)memory.set(k,structuredClone(v));},async delete(k:string){memory.delete(k);},async getAlarm(){return null;},async setAlarm(_value:number){}}};
  let coordinator:PlatformCoordinator;
  const env:Env={PLATFORM_CONFIG:JSON.stringify({chainId:10143,manager,token,factory,operator:operator!.address,worker:platformWorker!.address,sponsor:sponsor!.address,rpcUrl:'https://taker-rpc.test',storageUrl:'https://platform.test',deploymentBlock:'0'}),PLATFORM_OPERATOR_KEY:bytesToHex(operator!.getHdKey().privateKey!),PLATFORM_WORKER_KEY:bytesToHex(platformWorker!.getHdKey().privateKey!),PLATFORM_SPONSOR_KEY:bytesToHex(sponsor!.getHdKey().privateKey!),PLATFORM:{idFromName:()=>1,get:()=>({fetch:(u:string,i:RequestInit)=>coordinator.fetch(new Request(u,i))})}as any,DB:{prepare(sql){let args:SQLInputValue[]=[];return{bind(...v){args=v as SQLInputValue[];return this;},async first<T>(){return(db.prepare(sql).get(...args)??null)as T|null;},async run(){return db.prepare(sql).run(...args);}};}}};
  coordinator=new PlatformCoordinator(ctx as any,env);
  async function call(path:string,body?:unknown,cookie='',bearer=''){const request=new Request(`https://platform.test/platform/${path}`,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{origin:'https://platform.test','content-type':'application/json',cookie,...(bearer?{authorization:`Bearer ${bearer}`}:{})}});return path.startsWith('taker/')?takerApi(request,env):platformApi(request,env);}
  async function ok(path:string,body?:unknown,cookie='',bearer=''){const r=await call(path,body,cookie,bearer);const value=await r.json() as any;assert(r.ok,JSON.stringify(value));return value;}
  async function login(i:number){const account=accounts[i]!;const c=await ok('auth/challenge',{address:account.address});const r=await call('auth/verify',{id:c.id,signature:await account.signMessage({message:c.message})});assert(r.ok);return r.headers.get('set-cookie')!.split(';')[0]!;}
  const rCookie=await login(3);const cookies=[await login(4),await login(5)];
  const stores=new Map<string,Map<string,any>>();const runners=new Map<string,HostedRunner>();const contexts=new Map<string,any>();let crashRun:string|undefined;
  env.HOSTED={idFromName:(id:string)=>id,get:(id:string)=>({fetch:async(url:string,init:RequestInit)=>{
    if(!runners.has(id)){
      const memory=new Map<string,any>();stores.set(id,memory);
      const context={storage:{async get(k:string){return structuredClone(memory.get(k));},async put(k:string,v:any){memory.set(k,structuredClone(v));if(k==='execution'&&crashRun===id){crashRun=undefined;throw new Error('process lost after persisting artifact');}},async getAlarm(){return memory.get('alarm')??null;},async setAlarm(v:number){memory.set('alarm',v);},async deleteAlarm(){memory.delete('alarm');}}};
      contexts.set(id,context);runners.set(id,new HostedRunner(context as any,env));
    }
    return runners.get(id)!.fetch(new Request(url,init));
  }})}as any;
  const seen:Array<{task:string;input:string}>=[];let releaseA:((result:any)=>void)|undefined;let startedA:()=>void=()=>{};const started=new Promise<void>(r=>startedA=r);
  env.PLATFORM_AI_MODEL='test-generation';env.PLATFORM_JUDGE_MODEL='test-judge';env.AI={run:async(model:string,input:any)=>{
    const user=JSON.parse(input.messages[1].content);const system=input.messages[0].content;
    if(model==='test-judge')return{response:system.includes('quotation entailment')?{checks:user.pairs.map((p:any)=>({index:p.index,supported:true,reason:'fixture support'}))}:{accept:true,checks:[{name:'fixture-review',passed:true,detail:'fixture only'}]}};
    seen.push({task:user.task,input:JSON.stringify(input)});
    const response={response:{summary:'指定账户支持批量交易与 gas 代付。',findings:[{title:'账户能力',claim:'指定账户支持批量交易与 gas 代付。',quoteId:user.passages[0].id}]}};
    if(user.task.includes('ALPHA_PRIVATE')){startedA();return new Promise(resolve=>releaseA=()=>resolve(response));}
    if(user.task.includes('FAILURE_PRIVATE'))return{response:'invalid-json'};
    return response;
  }}as any;
  const prepare=async(user:number,kind:'analysis'|'research',marker:string)=>{
    const goalId=crypto.randomUUID();await ok('plans',{id:goalId,goal:`${marker}：按照约定来源独立执行并交付结果。`,kind,execution:'market',reward:'50000',...(kind==='analysis'?{fromBlock:'1',toBlock:'2'}:{sourceUrls:['https://docs.monad.xyz/hosted-fixture.md']})},rCookie);
    await ok('launch',{id:crypto.randomUUID(),goalId},rCookie);await coordinator.alarm();
    const goals=await ok('goals',undefined,rCookie);const goal=goals.goals.find((g:any)=>g.id===goalId);const id=crypto.randomUUID();
    assert.equal((await call('taker/runs/prepare',{id,taskId:goal.taskId,mode:'sponsored',hostedAgent:kind==='analysis'?'transfers-v1':'research-v1'},cookies[user])).status,400);
    assert.equal(db.prepare('SELECT count(*) n FROM platform_runs WHERE id=?').get(id)!.n,0);
    // Seed a pre-retirement, already-claimed run through an external wallet.
    const plan=await ok('taker/runs/prepare',{id,taskId:goal.taskId,mode:'sponsored'},cookies[user]);
    const account=accounts[user+4]!;await ok('taker/runs/authorize',{id,claimSignature:await account.signTypedData(plan.claimTypedData),submitSignature:await account.signTypedData(plan.submitTypedData)},cookies[user]);
    await receipt(await wallets[user+4]!.writeContract({address:manager,abi:taskManagerAbi,functionName:'claimTask',args:[BigInt(goal.taskId)]}));
    const agent=kind==='analysis'?'transfers-v1':'research-v1';
    db.prepare("UPDATE platform_runs SET body=json_set(body,'$.hostedAgent',?) WHERE id=?").run(agent,id);
    const at=new Date().toISOString();const data={id,owner:account.address.toLowerCase(),agent,agentName:'Legacy agent',taskId:goal.taskId,attempt:'1',status:'running',message:'Legacy work',metrics:{modelRequests:0,toolQueries:0,executionTries:0},costs:{serviceFeeBaseUnits:'0',computePayer:'platform',gasPayer:'platform',confirmedGasWei:null,gasTransactions:[]},logs:[],createdAt:at,updatedAt:at};
    db.prepare('INSERT INTO platform_hosted_jobs(id,owner,agent,body,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id,data.owner,agent,JSON.stringify(data),Date.now(),Date.now());
    await env.HOSTED!.get(env.HOSTED!.idFromName(id)).fetch('https://internal/wake',{method:'POST',body:JSON.stringify({id,owner:data.owner})});
    return{id,taskId:goal.taskId,goalId,user,runner:runners.get(id)!};
  };
  const a=await prepare(0,'research','ALPHA_PRIVATE');const b=await prepare(1,'research','BETA_PRIVATE');
  assert.equal((await call(`taker/runs/${a.id}`,undefined,cookies[1])).status,404);
  const externalToken='aa'.repeat(32),externalId=crypto.randomUUID();await ok('taker/pair',{id:externalId,tokenHash:keccak256(stringToHex(externalToken)),name:'external'});await ok('taker/pair/approve',{id:externalId},cookies[0]);assert.equal((await call(`taker/runs/${a.id}`,undefined,'',externalToken)).status,404,'external bearer never gets a hosted assignment');
  assert.deepEqual((await ok('taker/hosted/catalog')).agents,[]);
  const pendingA=a.runner.alarm();await started;
  await b.runner.alarm();await coordinator.alarm();for(let i=0;i<4;i++)await coordinator.alarm();await b.runner.alarm();
  const bState=await ok(`taker/runs/${b.id}`,undefined,cookies[1]);assert.equal(bState.hosted.status,'completed');assert.equal(bState.hosted.metrics.modelRequests,1);assert.equal(bState.hosted.costs.serviceFeeBaseUnits,'0');assert(BigInt(bState.hosted.costs.confirmedGasWei)>0n);assert.equal(bState.owner,accounts[5]!.address.toLowerCase());
  await ok(`taker/runs/${a.id}/revoke`,{},cookies[0]);const stopped=await ok(`taker/runs/${a.id}`,undefined,cookies[0]);assert.equal(stopped.hosted.status,'stopped');assert.equal(stopped.task.status,1,'stop must not pretend to release a chain claim');
  await pendingA;releaseA!(null);const aState=await ok(`taker/runs/${a.id}`,undefined,cookies[0]);assert.equal(aState.resultHash,null);assert.equal(aState.hosted.status,'stopped');assert.equal(db.prepare("SELECT count(*) n FROM platform_commands WHERE id=?").get(`${a.id}:submit`)!.n,0);
  assert(seen.some(c=>c.task.includes('ALPHA_PRIVATE'))&&seen.some(c=>c.task.includes('BETA_PRIVATE')));for(const call of seen){assert(!(call.input.includes('ALPHA_PRIVATE')&&call.input.includes('BETA_PRIVATE')));for(const account of accounts)assert(!call.input.includes(bytesToHex(account.getHdKey().privateKey!)),'model must not receive signing credentials');}
  const c=await prepare(0,'analysis','RECOVERY_PRIVATE');crashRun=c.id;await c.runner.alarm();assert(stores.get(c.id)!.has('execution'));
  const recovered=new HostedRunner(contexts.get(c.id),env);await recovered.alarm();await recovered.alarm();await coordinator.alarm();for(let i=0;i<5;i++)await coordinator.alarm();await recovered.alarm();
  const cState=await ok(`taker/runs/${c.id}`,undefined,cookies[0]);assert.equal(cState.hosted.status,'completed');assert.equal(cState.hosted.metrics.executionTries,1);assert.equal(cState.task.attempt,'1');assert.equal(db.prepare('SELECT count(*) n FROM platform_commands WHERE id=?').get(`${c.id}:submit`)!.n,1);
  const d=await prepare(1,'research','FAILURE_PRIVATE');await d.runner.alarm();await coordinator.alarm();await d.runner.alarm();await d.runner.alarm();
  const dState=await ok(`taker/runs/${d.id}`,undefined,cookies[1]);assert.equal(dState.hosted.status,'failed');assert.equal(dState.hosted.metrics.executionTries,2);assert.equal(dState.resultHash,null);assert.equal(db.prepare('SELECT count(*) n FROM platform_commands WHERE id=?').get(`${d.id}:submit`)!.n,0);
  await raw('evm_increaseTime',[700]);await raw('evm_mine',[]);for(let i=0;i<5;i++)await coordinator.alarm();
  for(const job of [a,d])await receipt(await wallets[3]!.writeContract({address:vault,abi:requesterVaultAbi,functionName:'cancelTask',args:[BigInt(job.taskId)]}));
  assert.equal(await client.readContract({address:manager,abi:taskManagerAbi,functionName:'totalEscrowed'}),0n);assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[accounts[4]!.address]}),50000n);assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[accounts[5]!.address]}),50000n);
 }finally{globalThis.fetch=nativeFetch;db.close();anvil.kill('SIGTERM');}
});
