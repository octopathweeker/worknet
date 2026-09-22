import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {createPublicClient,createWalletClient,http,erc20Abi,bytesToHex,parseAbi,type Hex,type LocalAccount} from 'viem';
import {monadTestnet} from 'viem/chains';
import {mnemonicToAccount} from 'viem/accounts';
import {factoryAbi} from '@agent-task/accounts';
import {requesterVaultAbi} from '@agent-task/contracts';
import {deliverySalt,deliveryPrivateKey,deliveryPublicKey,deliveryContext,isPrivateOutput,openJson,verifiedOpening} from '@agent-task/privacy';
import {PlatformCoordinator} from '../apps/object-store/src/platform-coordinator.js';
import {platformApi} from '../apps/object-store/src/platform-api.js';
import type {Env} from '../apps/object-store/src/index.js';

test('Mera signing account funds its Vault and platform settles a private task without persisting report plaintext',{timeout:120000},async()=>{
 const require=createRequire(new URL('../apps/explorer/package.json',import.meta.url));
 const {createSecp256k1SigningSession}=await import(require.resolve('@category-labs/mera'));
 const {toViemAccount}=await import(require.resolve('@category-labs/mera/viem'));
 // Local fixture key; real PRF creation/reconstruction is covered by mera-account.test.ts.
 const signer=createSecp256k1SigningSession({privateKey:new Uint8Array(32).fill(19)}),owner=toViemAccount(signer) as LocalAccount;
 const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
 const node=spawn('.tools/foundry/anvil',['--network','monad','--hardfork','MonadNine','--chain-id','10143','--port',String(port),'--silent'],{stdio:'ignore'});
 const rpc=`http://127.0.0.1:${port}`,nativeFetch=globalThis.fetch;
 const client=createPublicClient({chain:monadTestnet,transport:http(rpc),pollingInterval:50});
 const roles=Array.from({length:3},(_,addressIndex)=>mnemonicToAccount('test test test test test test test test test test test junk',{addressIndex}));
 const wallets=roles.map(account=>createWalletClient({account,chain:monadTestnet,transport:http(rpc)}));
 const user=createWalletClient({account:owner,chain:monadTestnet,transport:http(rpc)});
 const db=new DatabaseSync(':memory:');db.exec(readFileSync('apps/object-store/schema.sql','utf8'));db.exec(readFileSync('apps/object-store/platform-schema.sql','utf8'));
 try{
  for(let i=0;;i++){try{await client.getChainId();break;}catch{if(i>40)throw new Error('anvil startup');await new Promise(r=>setTimeout(r,100));}}
  await nativeFetch(rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'anvil_setBalance',params:[owner.address,'0x3635c9adc5dea00000']})});
  const receipt=async(hash:Hex)=>{const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r;};
  const deploy=async(name:string,args:unknown[]=[])=>{const a=JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`,'utf8'));return(await receipt(await wallets[0]!.deployContract({abi:a.abi,bytecode:a.bytecode.object,args}))).contractAddress!;};
  const token=await deploy('MockUSDC'),manager=await deploy('TaskManager',[token,[roles[0]!.address],1]),factory=await deploy('RequesterVaultFactory',[manager,token]);
  await receipt(await wallets[0]!.writeContract({address:token,abi:parseAbi(['function mint(address,uint256)']),functionName:'mint',args:[owner.address,1000000n]}));
  await receipt(await user.writeContract({address:factory,abi:factoryAbi,functionName:'createVault',args:[owner.address]}));
  const vault=await client.readContract({address:factory,abi:factoryAbi,functionName:'vaultOf',args:[owner.address]});
  await receipt(await user.writeContract({address:token,abi:erc20Abi,functionName:'approve',args:[vault,500000n]}));
  await receipt(await user.writeContract({address:vault,abi:requesterVaultAbi,functionName:'deposit',args:[500000n]}));
  await receipt(await user.writeContract({address:vault,abi:requesterVaultAbi,functionName:'authorizeAgent',args:[roles[1]!.address,{validAfter:0n,validUntil:(await client.getBlock()).timestamp+86400n,maxPerTask:200000n,maxTotalCommitment:500000n}]}));
  globalThis.fetch=async(input,init)=>{if(!String(input).startsWith('https://private-rpc.test'))return nativeFetch(input,init);const body=JSON.parse(String(init?.body));if(body.method==='eth_getBlockByNumber'&&body.params[0]==='finalized')body.params[0]='latest';if(body.method==='eth_call'&&body.params[1]==='finalized')body.params[1]='latest';return nativeFetch(rpc,{...init,body:JSON.stringify(body)});};
  const memory=new Map<string,unknown>();const ctx={storage:{async get(k:string){return structuredClone(memory.get(k));},async put(k:string|Record<string,unknown>,v?:unknown){if(typeof k==='string')memory.set(k,structuredClone(v));else for(const[a,b]of Object.entries(k))memory.set(a,structuredClone(b));},async delete(k:string){memory.delete(k);},async list(o:any){return new Map([...memory].filter(([k])=>k.startsWith(o.prefix)&&(!o.startAfter||k>o.startAfter)).sort().slice(0,o.limit));},async setAlarm(v:number){memory.set('alarm',v);},async getAlarm(){return memory.get('alarm')??null;}}};
  let coordinator:PlatformCoordinator;
  const env:Env={PLATFORM_CONFIG:JSON.stringify({chainId:10143,manager,factory,token,worker:roles[2]!.address,operator:roles[1]!.address,sponsor:roles[0]!.address,rpcUrl:'https://private-rpc.test',storageUrl:'https://platform.test',deploymentBlock:'0'}),PLATFORM_OPERATOR_KEY:bytesToHex(roles[1]!.getHdKey().privateKey!),PLATFORM_WORKER_KEY:bytesToHex(roles[2]!.getHdKey().privateKey!),DELIVERY_REVIEW_KEY:bytesToHex(new Uint8Array(32).fill(9)),PLATFORM:{idFromName:()=>1,get:()=>({fetch:async()=>new Response('ok')})}as any,DB:{prepare(sql){let values:SQLInputValue[]=[];return{bind(...v){values=v as SQLInputValue[];return this;},async first<T>(){return(db.prepare(sql).get(...values)??null)as T|null;},async run(){return db.prepare(sql).run(...values);}};}}};
  coordinator=new PlatformCoordinator(ctx as any,env);
  const api=async(path:string,body?:unknown,cookie='')=>platformApi(new Request(`https://platform.test/platform/${path}`,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{'content-type':'application/json',origin:'https://platform.test',cookie}}),env);
  const challenge=await(await api('auth/challenge',{address:owner.address})).json()as any;
  const login=await api('auth/verify',{id:challenge.id,signature:await owner.signMessage({message:challenge.message})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  const config=await(await api('config')).json()as any;const key=deliveryPrivateKey(new Uint8Array(32).fill(6));const id=crypto.randomUUID();
  const delivery={scheme:'worknet-delivery/1',rpId:'platform.test',salt:deliverySalt('platform.test',owner.address,id),publicKey:deliveryPublicKey(key),reviewPublicKey:config.privacy.reviewPublicKey};
  const plan=await api('plans',{id,goal:'独立统计指定区间的转账，交付私有报告。',kind:'analysis',execution:'platform',reward:'50000',fromBlock:'1',toBlock:'2',delivery},cookie);assert.equal(plan.status,200,JSON.stringify(await plan.json()));
  assert.equal((await api('launch',{id:crypto.randomUUID(),goalId:id},cookie)).status,202);
  let goal:any;
  for(let i=0;i<16;i++){await coordinator.alarm();const page=await(await api('goals',undefined,cookie)).json()as any;goal=page.goals.find((g:any)=>g.id===id);if(goal?.task?.status===3)break;}
  assert.equal(goal?.task?.status,3,JSON.stringify(goal));assert.equal(goal.evidence.verdict,'accept');assert(isPrivateOutput(goal.result.output));
  const opening=await openJson(goal.result.output.envelope,key,deliveryContext(goal.result));const output=verifiedOpening(goal.result.output,opening) as any;assert.equal(output.eventCount,'0');key.fill(0);
  const object=JSON.parse(db.prepare('SELECT body FROM objects WHERE hash=?').get(goal.task.resultHash)!.body as string);assert(isPrivateOutput(object.output));assert.equal(object.output.eventCount,undefined);
  assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[roles[2]!.address]}),50000n);
  assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[vault]}),450000n);
 }finally{globalThis.fetch=nativeFetch;signer.end();node.kill('SIGTERM');db.close();}
});
