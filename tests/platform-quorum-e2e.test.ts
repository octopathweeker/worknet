import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createPublicClient, createWalletClient, http, bytesToHex, erc20Abi, type Address } from 'viem';
import { monadTestnet } from 'viem/chains';
import { mnemonicToAccount } from 'viem/accounts';
import { requesterVaultAbi, taskManagerAbi } from '@agent-task/contracts';
import { factoryAbi } from '@agent-task/accounts';
import { canonicalJson, hashJson } from '@agent-task/protocol/json';
import { PlatformCoordinator } from '../apps/object-store/src/platform-coordinator.js';
import { makeTask, taskParams } from '../apps/object-store/src/platform-domain.js';
import { internalModel } from '../apps/object-store/src/internal-model.js';
import judgeWorker, { JudgeEvaluation, type JudgeEnv } from '../apps/judge-worker/src/index.js';
import type { Env } from '../apps/object-store/src/index.js';

function context(memory=new Map<string,unknown>(), crash?: (entries:Record<string,any>)=>void) {
  return {memory,storage:{
    async get(key:string){return structuredClone(memory.get(key));},
    async put(key:string|Record<string,unknown>,value?:unknown){const entries=typeof key==='string'?{[key]:value}:key;crash?.(entries);for(const [k,v] of Object.entries(entries))memory.set(k,structuredClone(v));},
    async delete(key:string){memory.delete(key);},async getAlarm(){return memory.get('alarm')??null;},async setAlarm(at:number){memory.set('alarm',at);},
    async list(options:{prefix:string;limit:number;startAfter?:string}){return new Map([...memory].filter(([k])=>k.startsWith(options.prefix)&&(!options.startAfter||k>options.startAfter)).sort(([a],[b])=>a.localeCompare(b)).slice(0,options.limit));},
  }};
}
test('cloud quorum resumes settlement, survives one offline peer and reconciles owner settlement with a missing quorum receipt', {timeout:120000},async()=>{
  const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));
  const anvil=spawn('.tools/foundry/anvil',['--network','monad','--hardfork','MonadNine','--chain-id','10143','--block-time','1','--port',String(port),'--silent'],{stdio:'ignore'});
  const rpc=`http://127.0.0.1:${port}`;const nativeFetch=globalThis.fetch;
  const db=new DatabaseSync(':memory:');db.exec(readFileSync('apps/object-store/schema.sql','utf8'));db.exec(readFileSync('apps/object-store/platform-schema.sql','utf8'));
  const accounts=Array.from({length:8},(_,addressIndex)=>mnemonicToAccount('test test test test test test test test test test test junk',{addressIndex}));
  const client=createPublicClient({chain:monadTestnet,transport:http(rpc),pollingInterval:100});
  const wallets=accounts.map(account=>createWalletClient({chain:monadTestnet,account,transport:http(rpc)}));
  const confirmed=async(hash:`0x${string}`)=>{const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r;};
  try{
    for(let i=0;;i++){try{await client.getChainId();break;}catch{if(i>40)throw new Error('ANVIL_TIMEOUT');await new Promise(r=>setTimeout(r,100));}}
    async function deploy(name:string,args:unknown[]=[]){const a=JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`,'utf8'));return (await confirmed(await wallets[0]!.deployContract({abi:a.abi,bytecode:a.bytecode.object,args}))).contractAddress!;}
    const token=await deploy('MockUSDC');const manager=await deploy('TaskManager',[token,accounts.slice(5).map(a=>a.address),2]);const factory=await deploy('RequesterVaultFactory',[manager,token]);
    await confirmed(await wallets[3]!.writeContract({address:factory,abi:factoryAbi,functionName:'createVault',args:[accounts[3]!.address]}));
    const vault=await client.readContract({address:factory,abi:factoryAbi,functionName:'vaultOf',args:[accounts[3]!.address]});
    await confirmed(await wallets[0]!.writeContract({address:token,abi:[...erc20Abi,{type:'function',name:'mint',stateMutability:'nonpayable',inputs:[{type:'address',name:'to'},{type:'uint256',name:'amount'}],outputs:[]}],functionName:'mint',args:[vault,1000000n]}));
    const now=(await client.getBlock()).timestamp;
    await confirmed(await wallets[3]!.writeContract({address:vault,abi:requesterVaultAbi,functionName:'authorizeAgent',args:[accounts[1]!.address,{validAfter:0n,validUntil:now+86400n,maxPerTask:200000n,maxTotalCommitment:1000000n}]}));
    let modelCalls=0;let overload=true;let crashed=false;
    const coordinatorCtx=context(new Map(),entries=>{if(!crashed&&Object.entries(entries).some(([k,v])=>k.startsWith('tx:operator:quorum-settle:')&&v.status==='confirmed')){crashed=true;throw new Error('injected loss after receipt');}});
    const config={chainId:10143 as const,manager,factory,token,operator:accounts[1]!.address,worker:accounts[2]!.address,sponsor:accounts[0]!.address,rpcUrl:'https://quorum-rpc.test',storageUrl:'https://platform.test',deploymentBlock:'0',quorum:{judges:accounts.slice(5).map(a=>a.address),threshold:2}};
    const env:Env={PLATFORM_CONFIG:JSON.stringify(config),PLATFORM_OPERATOR_KEY:bytesToHex(accounts[1]!.getHdKey().privateKey!),PLATFORM_WORKER_KEY:bytesToHex(accounts[2]!.getHdKey().privateKey!),PLATFORM_SPONSOR_KEY:bytesToHex(accounts[0]!.getHdKey().privateKey!),JUDGE_SERVICE_TOKEN:'j'.repeat(32),MODEL_GATEWAY_TOKEN:'g'.repeat(32),OPENROUTER_API_KEY:'fake-existing-key',DB:{prepare(sql){let values:SQLInputValue[]=[];return{bind(...v){values=v as SQLInputValue[];return this;},async first<T>(){return (db.prepare(sql).get(...values)??null) as T|null;},async run(){return db.prepare(sql).run(...values);}};}}};
    globalThis.fetch=async(input,init)=>{
      const url=String(input);
      if(url.startsWith('https://quorum-rpc.test')){const body=JSON.parse(String(init?.body));if(body.method==='eth_getBlockByNumber'&&body.params[0]==='finalized')body.params[0]='latest';if(body.method==='eth_call'&&body.params[1]==='finalized')body.params[1]='latest';return nativeFetch(rpc,{...init,body:JSON.stringify(body)});}
      if(url.startsWith('https://docs.monad.xyz/'))return new Response('This is an independently retrieved source passage supporting the task.');
      if(url==='https://openrouter.ai/api/v1/systemone'){
        assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fake-existing-key');modelCalls++;
        if(overload){overload=false;return new Response('{}',{status:429});}
        const body=JSON.parse(String(init?.body));const id=body.questions.completion.instructions.judge;
        return new Response(JSON.stringify({model:'typesafe/jev-1.13',answers:{completion:{type:'score',score:{'judge-1':4,'judge-2':3,'judge-3':2}[id as string]}}}));
      }
      return nativeFetch(input,init);
    };
    const peers:JudgeEnv[]=[];
    for(let i=0;i<3;i++){
      const evaluations=new Map<string,JudgeEvaluation>();
      const peer:JudgeEnv={JUDGE_ID:`judge-${i+1}`,JUDGE_CONFIG:JSON.stringify({chainId:10143,manager,rpcUrl:config.rpcUrl}),JUDGE_PRIVATE_KEY:bytesToHex(accounts[i+5]!.getHdKey().privateKey!),JUDGE_SERVICE_TOKEN:env.JUDGE_SERVICE_TOKEN!,MODEL_GATEWAY_TOKEN:env.MODEL_GATEWAY_TOKEN!,MODEL_GATEWAY:{fetch:r=>internalModel(r,env)},EVALUATIONS:{idFromName:(n:string)=>n,get:(id:string)=>({fetch:(url:string,init:RequestInit)=>{if(!evaluations.has(id))evaluations.set(id,new JudgeEvaluation(context() as any,peer));return evaluations.get(id)!.fetch(new Request(url,init));}})} as any};
      peers.push(peer);env[`JUDGE_${i+1}` as 'JUDGE_1'|'JUDGE_2'|'JUDGE_3']={fetch:r=>judgeWorker.fetch(r,peer)};
    }
    const unavailable=await judgeWorker.fetch(new Request('https://judge/evaluate',{method:'POST',body:'{}'}),peers[0]!);assert.equal(unavailable.status,401);
    for(let n=1;n<=3;n++){
      const goal:any={id:crypto.randomUUID(),owner:accounts[3]!.address.toLowerCase(),vault:vault.toLowerCase(),input:{goal:'Check the provided source and summarize the supported fact.',kind:'research',reward:'50000',execution:'market'},createdAt:new Date().toISOString(),status:'running'};
      const head=await client.getBlock();goal.spec=makeTask(goal,config,Number(head.timestamp),head.number);
      await confirmed(await wallets[1]!.writeContract({address:vault,abi:requesterVaultAbi,functionName:'createTask',args:[goal.spec.clientRequestId,taskParams(goal.spec,config.storageUrl)]}));
      const id=await client.readContract({address:manager,abi:taskManagerAbi,functionName:'getTaskByRequestId',args:[vault,goal.spec.clientRequestId]});goal.taskId=id.toString();
      await confirmed(await wallets[2]!.writeContract({address:manager,abi:taskManagerAbi,functionName:'claimTask',args:[id]}));
      const specHash=hashJson(goal.spec);const result={protocol:'agent-task/0.1',settlementChainId:'10143',taskManager:manager.toLowerCase(),taskId:id.toString(),attempt:'1',worker:accounts[2]!.address.toLowerCase(),specHash,output:{summary:'A supported summary.',findings:[{title:'Fact',claim:'Source supports the task.',sourceUri:goal.spec.input.sourceUrls[0],quote:'This is an independently retrieved source passage supporting the task.'}]},artifacts:[],provenance:{}};
      const resultHash=hashJson(result);db.prepare('INSERT INTO objects(hash,body,created_at) VALUES (?,?,0)').run(resultHash,canonicalJson(result));
      await confirmed(await wallets[2]!.writeContract({address:manager,abi:taskManagerAbi,functionName:'submitResult',args:[id,1n,resultHash,`${config.storageUrl}/objects/${resultHash}`]}));
      db.prepare('INSERT INTO platform_goals(id,owner,body,active,updated_at) VALUES (?,?,?,1,0)').run(goal.id,goal.owner,JSON.stringify(goal));
      if(n===3){
        await confirmed(await wallets[3]!.writeContract({address:vault,abi:requesterVaultAbi,functionName:'acceptResult',args:[id,1n,resultHash]}));
        const key=`tx:operator:quorum-settle:${id}:1:${resultHash}`;
        const prior=[...coordinatorCtx.memory].find(([k])=>k.startsWith('tx:operator:quorum-settle:'))![1] as any;
        const pending={...prior,hash:`0x${'ab'.repeat(32)}`,status:'signed'};
        coordinatorCtx.memory.set(key,pending);
        const calls=modelCalls;const nonce=await client.getTransactionCount({address:accounts[1]!.address});
        await new PlatformCoordinator(coordinatorCtx as any,env).alarm();
        const row=db.prepare('SELECT body,active FROM platform_goals WHERE id=?').get(goal.id)!;
        const reconciled=JSON.parse(String(row.body));
        assert.equal(row.active,0,'finalized owner settlement ends background processing');
        assert.equal(reconciled.task.status,3);assert.equal(reconciled.error,undefined);
        assert.equal(reconciled.settlement,undefined,'missing receipt never fabricates a quorum payment');
        assert.equal(JSON.parse(String(db.prepare('SELECT body FROM platform_health').get()!.body)).ready,true);
        assert.deepEqual(coordinatorCtx.memory.get(key),pending,'uncertain signed outbox is retained');
        assert.equal(modelCalls,calls);assert.equal(await client.getTransactionCount({address:accounts[1]!.address}),nonce,'no transaction is resent');
        continue;
      }
      if(n===2)env.JUDGE_2={fetch:async()=>new Response('{}',{status:503})};
      const request=()=>new Request('https://judge/evaluate',{method:'POST',headers:{authorization:`Bearer ${env.JUDGE_SERVICE_TOKEN}`},body:JSON.stringify({spec:goal.spec,result,taskId:id.toString(),attempt:'1',specHash,resultHash})});
      const first=await judgeWorker.fetch(request(),peers[0]!);assert.equal(first.status,200,await first.clone().text());const saved=await first.json();const calls=modelCalls;
      assert.deepEqual(await (await judgeWorker.fetch(request(),peers[0]!)).json(),saved);assert.equal(modelCalls,calls,'durable cached vote does not invoke model again');
      let coordinator=new PlatformCoordinator(coordinatorCtx as any,env);
      for(let tick=0;tick<8;tick++){
        await coordinator.alarm();coordinator=new PlatformCoordinator(coordinatorCtx as any,env);
        const body=JSON.parse(String(db.prepare('SELECT body FROM platform_goals WHERE id=?').get(goal.id)!.body));
        if(body.settlement)break;
      }
      const finished=JSON.parse(String(db.prepare('SELECT body FROM platform_goals WHERE id=?').get(goal.id)!.body));
      assert.equal(finished.settlement?.completionBps,n===1?7500:5000,JSON.stringify(finished));
      assert.equal(finished.settlement.workerAmount,n===1?'37500':'25000');assert.equal(finished.settlement.refundAmount,n===1?'12500':'25000');assert.equal(finished.evidence.verdict,'scored');
      const logs=await client.getContractEvents({address:manager,abi:taskManagerAbi,eventName:'VerdictSettled',args:{taskId:id},fromBlock:0n});assert.equal(logs.length,1,'restart never settles twice');
    }
    assert(crashed);assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[accounts[2]!.address]}),112500n);
    assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[vault]}),887500n);
  }finally{globalThis.fetch=nativeFetch;db.close();anvil.kill('SIGTERM');await new Promise<void>(r=>anvil.once('exit',()=>r()));}
});
