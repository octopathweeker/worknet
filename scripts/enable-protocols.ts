import assert from 'node:assert/strict';
import { readFile, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, decodeEventLog, erc20Abi, parseAbi, parseEther, type Hex, type Address } from 'viem';
import { identityRegistryAbi, verifyWorkerBinding } from '@agent-task/identity';
import { checkTestnet, client, TEST_USDC } from './testnet-common.js';
import { JournalWallet, privateJson, persistPrivate } from './platform-chain.js';

const directory = '.runtime/m6/protocol';
const config = JSON.parse(await readFile('.runtime/m6/config.json', 'utf8'));
const platform = JSON.parse(await readFile('.runtime/m6/wrangler.jsonc', 'utf8'));
assert(config.chainId === 10143 && config.release === 'm6');
const registry: Address = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const serviceName = `${platform.name}-tools`;
const origin = new URL(config.storageUrl); origin.hostname = origin.hostname.replace(/^[^.]+/, serviceName);
const keys = await privateJson<Record<'registrar'|'provider'|'payer', Hex>>('accounts.private.json', () => ({ registrar: generatePrivateKey(), provider: generatePrivateKey(), payer: generatePrivateKey() }), directory);
const wallets = Object.fromEntries(Object.entries(keys).map(([role,key])=>[role,new JournalWallet(key,role,directory)])) as Record<keyof typeof keys,JournalWallet>;
const serviceSecret = await privateJson('service-secret.private.json', () => ({ value:randomBytes(32).toString('hex') }), directory);
const state = await privateJson<any>('activation.json', () => ({ registry, serviceOrigin:origin.origin }), directory);
assert.equal(state.registry,registry); assert.equal(state.serviceOrigin,origin.origin);
const save = () => persistPrivate('activation.json',state,directory);
await checkTestnet(); assert((await client.getCode({address:registry,blockTag:'finalized'}))?.length! > 2);
const registryName = await client.readContract({address:registry,abi:parseAbi(['function name() view returns (string)']),functionName:'name'});
assert.equal(registryName,'AgentIdentity');
console.log(JSON.stringify({mode:process.argv.includes('--broadcast')?'broadcast':'preflight',registry,serviceOrigin:origin.origin,roles:Object.fromEntries(Object.entries(wallets).map(([role,w])=>[role,w.account.address])),limits:{perCall:'0.001 test USDC',perTask:'0.002 test USDC',perDay:'0.01 test USDC',gasPerCall:'0.05 test MON'}}));
if (!process.argv.includes('--broadcast')) process.exit(0);
const lock=await open(`${directory}/activation.lock`,'wx',0o600);
try {
  const roleKey=async(role:string,variable:string)=>{
    const source=await readFile(`.runtime/testnet-accounts/${role}.env`,'utf8');
    const value=new RegExp(`^${variable}=(.+)$`,'m').exec(source)?.[1]?.trim().replace(/^['"]|['"]$/g,'');
    assert(value);return value as Hex;
  };
  const funder=new JournalWallet(await roleKey('deployer','DEPLOYER_PRIVATE_KEY'),'m6-deployer','.runtime/m6');
  const usdcFunder=new JournalWallet(await roleKey('owner','AGENT_PRIVATE_KEY'),'verification-funding-owner','.runtime/m6');
  // Fixed initial allocations, journaled once; rerunning never automatically tops up.
  for (const [role,amount] of [['registrar','0.15'],['provider','0.1'],['payer','0.15']] as const) {
    assert.equal((await funder.send(`protocol-${role}-gas-v1`,{to:wallets[role].account.address,value:parseEther(amount)})).status,'success');
  }
  assert.equal((await funder.send('protocol-operator-gas-v1',{to:config.operator,value:parseEther('0.1')})).status,'success');
  assert.equal((await usdcFunder.send('protocol-payer-usdc-v1',{to:TEST_USDC,data:encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[wallets.payer.account.address,20000n]})})).status,'success');
  for (const [role,wallet,uri] of [
    ['executor',wallets.registrar,`${origin.origin}/services/executor.json`],
    ['provider',wallets.provider,`${origin.origin}/services/agent.json`],
  ] as const) {
    const receipt=await wallet.send(`register-${role}`,{to:registry,data:encodeFunctionData({abi:identityRegistryAbi,functionName:'register',args:[uri]})});
    assert.equal(receipt.status,'success');
    const event=receipt.logs.filter(log=>log.address.toLowerCase()===registry.toLowerCase()).flatMap(log=>{
      try {const decoded=decodeEventLog({abi:identityRegistryAbi,data:log.data,topics:log.topics});return decoded.eventName==='Registered'?[decoded.args]:[];}catch{return [];}
    })[0];
    assert(event && event.owner.toLowerCase()===wallet.account.address.toLowerCase());
    state[role]={agentId:event.agentId.toString(),uri,owner:wallet.account.address,registrationTx:receipt.transactionHash};await save();
  }
  const executorId=BigInt(state.executor.agentId);
  if ((await client.readContract({address:registry,abi:identityRegistryAbi,functionName:'getAgentWallet',args:[executorId]})).toLowerCase()!==config.worker.toLowerCase()) {
    const secrets=JSON.parse(await readFile('.runtime/m6/platform-secrets.json','utf8'));
    const worker=privateKeyToAccount(secrets.PLATFORM_WORKER_KEY);assert.equal(worker.address.toLowerCase(),config.worker.toLowerCase());
    // Persist the exact bounded authorization; signature creation consumes no worker nonce.
    state.binding ??= {deadline:((await client.getBlock()).timestamp+240n).toString()};
    state.binding.signature ??= await worker.signTypedData({domain:{name:'ERC8004IdentityRegistry',version:'1',chainId:10143,verifyingContract:registry},types:{AgentWalletSet:[{name:'agentId',type:'uint256'},{name:'newWallet',type:'address'},{name:'owner',type:'address'},{name:'deadline',type:'uint256'}]},primaryType:'AgentWalletSet',message:{agentId:executorId,newWallet:worker.address,owner:wallets.registrar.account.address,deadline:BigInt(state.binding.deadline)}});
    await save();
    const receipt=await wallets.registrar.send('bind-executor-wallet',{to:registry,data:encodeFunctionData({abi:parseAbi(['function setAgentWallet(uint256 agentId,address newWallet,uint256 deadline,bytes signature)']),functionName:'setAgentWallet',args:[executorId,worker.address,BigInt(state.binding.deadline),state.binding.signature]})});
    assert.equal(receipt.status,'success');state.binding.transactionHash=receipt.transactionHash;await save();
  }
  const ref=(agentId:string)=>({chainId:'10143',registry,agentId});
  state.executor.snapshot=await verifyWorkerBinding(client,ref(state.executor.agentId),config.worker,[registry]);
  state.provider.snapshot=await verifyWorkerBinding(client,ref(state.provider.agentId),wallets.provider.account.address,[registry]);
  await save();
  const serviceConfig={agent:ref(state.provider.agentId),recipient:wallets.provider.account.address,priceBaseUnits:'1000',origin:origin.origin};
  const card={type:'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',name:'Worknet Platform Executor',description:'Worknet platform task executor on Monad Testnet. Delivery quality is independently verified; registration is not an endorsement.',active:true,services:[{name:'web',endpoint:platform.vars.WORKNET_PUBLIC_ORIGIN}],registrations:[{agentId:state.executor.agentId,agentRegistry:`eip155:10143:${registry}`}]};
  const db=await privateJson<{id?:string}>('database.json',()=>({}),directory);
  const template=JSON.parse(await readFile('apps/object-store/wrangler.tool-service.jsonc','utf8'));
  await persistPrivate('wrangler.jsonc',{...template,name:serviceName,main:path.resolve('apps/object-store/src/tool-service.ts'),d1_databases:[{binding:'DB',database_name:serviceName,database_id:db.id??'REPLACE_WITH_D1_DATABASE_ID'}],vars:{EXECUTOR_AGENT_CARD:JSON.stringify(card)}},directory);
  await persistPrivate('service-secrets.json',{PLATFORM_CONFIG:JSON.stringify(config),MPP_SERVICE_CONFIG:JSON.stringify(serviceConfig),MPP_SERVICE_SECRET:serviceSecret.value},directory);
  const identityConfig={registry,workers:{[config.worker.toLowerCase()]:ref(state.executor.agentId)}};
  const paymentConfig={endpoint:`${origin.origin}/services/transfers`,provider:ref(state.provider.agentId),maxPerCall:'1000',maxPerTask:'2000',maxPerDay:'10000',maxGasWei:parseEther('0.05').toString()};
  await persistPrivate('protocol-secrets.json',{ERC8004_CONFIG:JSON.stringify(identityConfig),MPP_TOOL_CONFIG:JSON.stringify(paymentConfig),MPP_PAYER_KEY:keys.payer},'.runtime/m6');
  console.log(JSON.stringify({prepared:true,executorAgentId:state.executor.agentId,providerAgentId:state.provider.agentId,endpoint:paymentConfig.endpoint}));
} finally {await lock.close();await unlink(`${directory}/activation.lock`);}
