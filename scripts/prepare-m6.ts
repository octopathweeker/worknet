import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeDeployData, keccak256, parseEther, type Address, type Hex, type Abi } from 'viem';
import { client, checkTestnet, TEST_USDC, rpcUrl } from './testnet-common.js';
import { JournalWallet, persistPrivate, privateJson } from './platform-chain.js';

// A new journal, D1, origin and signer set. Never repoint the original platform's vaults.
const directory='.runtime/m6';
const save=(name:string,value:unknown)=>persistPrivate(name,value,directory);
const old=JSON.parse(await readFile('.runtime/platform/config.json','utf8'));
const priorWrangler=JSON.parse(await readFile('apps/object-store/wrangler.local.jsonc','utf8'));
const workerName=process.env.M6_WORKER_NAME??`${priorWrangler.name}-m6`;
if(workerName===priorWrangler.name||!/^[-a-z0-9]{1,50}$/.test(workerName))throw new Error('NEW_WORKER_NAME_REQUIRED');
const origin=new URL(old.storageUrl);origin.hostname=origin.hostname.replace(/^[^.]+/,workerName);
const keys=await privateJson<Record<string,Hex>>('accounts.private.json',()=>Object.fromEntries(['operator','worker','sponsor','judge1','judge2','judge3'].map(role=>[role,generatePrivateKey()])),directory);
const addresses=Object.fromEntries(Object.entries(keys).map(([name,key])=>[name,privateKeyToAccount(key).address]));
const tokens=await privateJson('service-tokens.private.json',()=>({judge:randomBytes(32).toString('hex'),gateway:randomBytes(32).toString('hex'),upload:randomBytes(32).toString('hex')}),directory);
type DeploymentRecord = { release:string; manager?:Address; factory?:Address; deploymentBlock?:string; hashes?:{manager?:Hex;factory?:Hex} };
const record=await privateJson<DeploymentRecord>('deployment.json',()=>({release:'m6'}),directory);
if(record.release!=='m6')throw new Error('WRONG_RELEASE_JOURNAL');
await checkTestnet();
const deployerEnv=await readFile('.runtime/testnet-accounts/deployer.env','utf8');
const key=/^DEPLOYER_PRIVATE_KEY=(.+)$/m.exec(deployerEnv)?.[1]?.trim().replace(/^['"]|['"]$/g,'') as Hex;
if(!key)throw new Error('DEPLOYER_KEY_REQUIRED');
const deployer=new JournalWallet(key,'m6-deployer',directory);
console.log(JSON.stringify({mode:process.argv.includes('--broadcast')?'broadcast':'preflight',workerName,origin:origin.origin,legacyOrigin:old.storageUrl,deployer:deployer.account.address,deployerBalance:String(await client.getBalance({address:deployer.account.address})),judges:[addresses.judge1,addresses.judge2,addresses.judge3],threshold:2,existing:record},null,2));
if(!process.argv.includes('--broadcast'))process.exit(0);
await mkdir(directory,{recursive:true,mode:0o700});const lock=await open(`${directory}/deployment.lock`,'wx',0o600);
try{
  async function deploy(name:string,args:unknown[],field:'manager'|'factory'){
    const artifact=JSON.parse(await readFile(`contracts/out/${name}.sol/${name}.json`,'utf8')) as {abi:Abi;bytecode:{object:Hex}};
    const data=encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode.object,args});const hash=keccak256(data);
    if(record[field]){
      if(record.hashes?.[field]!==hash||!(await client.getCode({address:record[field]!})))throw new Error('DEPLOYMENT_ARTIFACT_CHANGED');
      return record[field]!;
    }
    const receipt=await deployer.send(`deploy-${name}`,{data});if(receipt.status!=='success'||!receipt.contractAddress)throw new Error('DEPLOY_FAILED');
    record[field]=receipt.contractAddress;record.hashes={...record.hashes,[field]:hash};if(field==='manager')record.deploymentBlock=receipt.blockNumber.toString();await save('deployment.json',record);return receipt.contractAddress;
  }
  const judges=[addresses.judge1!,addresses.judge2!,addresses.judge3!];
  const manager=await deploy('TaskManager',[TEST_USDC,judges,2],'manager');
  const factory=await deploy('RequesterVaultFactory',[manager,TEST_USDC],'factory');
  for(const role of ['operator','worker','sponsor']){
    const receipt=await deployer.send(`gas-${role}`,{to:addresses[role]!,value:parseEther(role==='sponsor'?'0.5':'0.3')});if(receipt.status!=='success')throw new Error('FUNDING_FAILED');
  }
  const config={release:'m6',chainId:10143,manager,factory,token:TEST_USDC,operator:addresses.operator,worker:addresses.worker,sponsor:addresses.sponsor,rpcUrl,storageUrl:origin.origin,deploymentBlock:record.deploymentBlock,legacyUrl:old.storageUrl,quorum:{judges,threshold:2}};
  await save('config.json',config);
  await save('platform-secrets.json',{PLATFORM_CONFIG:JSON.stringify(config),PLATFORM_OPERATOR_KEY:keys.operator,PLATFORM_WORKER_KEY:keys.worker,PLATFORM_SPONSOR_KEY:keys.sponsor,STORAGE_UPLOAD_TOKEN:tokens.upload,MODEL_GATEWAY_TOKEN:tokens.gateway,JUDGE_SERVICE_TOKEN:tokens.judge});
  await save('gateway-secrets.json',{MODEL_GATEWAY_TOKEN:tokens.gateway});
  const template=JSON.parse(await readFile('apps/object-store/wrangler.jsonc','utf8'));
  const db=await privateJson<{id?:string}>('database.json',()=>({}),directory);
  await save('wrangler.jsonc',{...template,name:workerName,main:path.resolve('apps/object-store/src/index.ts'),assets:{...template.assets,directory:path.resolve('apps/explorer/dist')},d1_databases:[{binding:'DB',database_name:workerName,database_id:db.id??'REPLACE_WITH_D1_DATABASE_ID'}],services:[{binding:'MODEL_GATEWAY',service:priorWrangler.name},...judges.map((_,i)=>({binding:`JUDGE_${i+1}`,service:`${workerName}-judge-${i+1}`}))]});
  for(let i=1;i<=3;i++){
    const judgeTemplate=JSON.parse(await readFile('apps/judge-worker/wrangler.jsonc','utf8'));
    await save(`judge-${i}.wrangler.jsonc`,{...judgeTemplate,name:`${workerName}-judge-${i}`,main:path.resolve('apps/judge-worker/src/index.ts'),vars:{JUDGE_ID:`judge-${i}`,JEV_MODEL:'jev-1.13'},services:[{binding:'MODEL_GATEWAY',service:priorWrangler.name}]});
    await save(`judge-${i}.secrets.json`,{JUDGE_CONFIG:JSON.stringify({chainId:10143,manager,rpcUrl}),JUDGE_PRIVATE_KEY:keys[`judge${i}`],JUDGE_SERVICE_TOKEN:tokens.judge,MODEL_GATEWAY_TOKEN:tokens.gateway});
  }
  console.log(JSON.stringify({prepared:true,origin:origin.origin,manager,factory,legacyUnchanged:old.manager!==manager,directory}));
}finally{await lock.close();await unlink(`${directory}/deployment.lock`);}
