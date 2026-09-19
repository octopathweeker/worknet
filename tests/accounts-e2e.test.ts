import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { monadTestnet } from 'viem/chains';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { factoryAbi, delegatedImplementation, isSupportedDelegation, exactPermission, permissionTypedData, redeemPermission, disablePermission, type AccountCall } from '@agent-task/accounts';
import { requesterVaultAbi } from '@agent-task/contracts';

test('real 7702 delegation code enforces exact batch, expiry, revocation and replay on local Monad', { timeout: 90000 }, async () => {
  const listener = createServer(); await new Promise<void>(r => listener.listen(0,'127.0.0.1',r)); const port = (listener.address() as {port:number}).port; await new Promise<void>(r=>listener.close(()=>r()));
  const process = spawn('.tools/foundry/anvil',['--network','monad','--hardfork','MonadNine','--chain-id','10143','--port',String(port),'--silent'],{stdio:'ignore'});
  const rpc = `http://127.0.0.1:${port}`;
  const client = createPublicClient({chain:monadTestnet,transport:http(rpc),pollingInterval:50});
  const sponsor = mnemonicToAccount('test test test test test test test test test test test junk');
  const user = privateKeyToAccount(`0x${'ab'.repeat(32)}`);
  const wallet = createWalletClient({chain:monadTestnet,account:sponsor,transport:http(rpc)});
  const request = async (method:string,params:unknown[]) => { const r = await fetch(rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}); const body = await r.json() as any;if(body.error)throw new Error(JSON.stringify(body.error));return body.result; };
  try {
    for(let i=0;;i++){try{await client.getChainId();break;}catch{if(i>40)throw new Error('Anvil startup');await new Promise(r=>setTimeout(r,100));}}
    const fixture = JSON.parse(readFileSync('tests/fixtures/7702-deployments.json','utf8'));
    for(const entry of Object.values(fixture.contracts) as Array<{address:Address;code:Hex}>)await request('anvil_setCode',[entry.address,entry.code]);
    async function deploy(name:string,args:unknown[]=[]){const artifact=JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`,'utf8')); const hash=await wallet.deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object,args});return (await client.waitForTransactionReceipt({hash})).contractAddress!;}
    const token=await deploy('MockUSDC');const manager=await deploy('TaskManager',[token]);const factory=await deploy('RequesterVaultFactory',[manager,token]);
    await request('anvil_setBalance',[user.address,'0x0']);
    const auth=await user.signAuthorization({chainId:10143,contractAddress:delegatedImplementation,nonce:0});
    // The deliberately failing execution must leave the authorization installed.
    const activation = await wallet.sendTransaction({to:user.address,data:'0xdeadbeef',authorizationList:[auth],gas:200000n});
    assert.equal((await client.waitForTransactionReceipt({hash:activation})).status,'reverted');assert(isSupportedDelegation(await client.getCode({address:user.address})));
    const mintAbi = [{type:'function',name:'mint',stateMutability:'nonpayable',inputs:[{name:'to',type:'address'},{name:'value',type:'uint256'}],outputs:[]}] as const;
    const minted=await wallet.writeContract({address:token,abi:mintAbi,functionName:'mint',args:[user.address,1000000n]});await client.waitForTransactionReceipt({hash:minted});
    const vault=await client.readContract({address:factory,abi:factoryAbi,functionName:'predictVault',args:[user.address]});
    const now=Number((await client.getBlock()).timestamp);
    const calls:AccountCall[]=[
      {target:factory,value:0n,callData:encodeFunctionData({abi:factoryAbi,functionName:'createVault',args:[user.address]})},
      {target:token,value:0n,callData:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[vault,500000n]})},
      {target:vault,value:0n,callData:encodeFunctionData({abi:requesterVaultAbi,functionName:'deposit',args:[500000n]})},
    ];
    async function sign(id:string,execution:AccountCall[],deadline=now+600){const p=exactPermission(user.address,sponsor.address,execution,id,deadline);p.signature=await user.signTypedData(permissionTypedData(p));return p;}
    const permission=await sign('batch',calls);
    await assert.rejects(client.call({...redeemPermission(permission,[calls[0]!]),account:sponsor}),/revert/i);
    const execute=async(p:Awaited<ReturnType<typeof sign>>,execution:AccountCall[])=>{const hash=await wallet.sendTransaction(redeemPermission(p,execution));const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');return receipt;};
    await execute(permission,calls);
    assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[vault]}),500000n);assert.equal(await client.getBalance({address:user.address}),0n);
    await assert.rejects(client.call({...redeemPermission(permission,calls),account:sponsor}),/revert/i);
    const noop=[calls[0]!];const revoked=await sign('revoked',noop);const disable=disablePermission(revoked);const revokeCalls=[{target:disable.to,value:0n,callData:disable.data}];await execute(await sign('disable',revokeCalls),revokeCalls);
    await assert.rejects(client.call({...redeemPermission(revoked,noop),account:sponsor}),/revert/i);
    const expired=await sign('expired',noop,now-1);await assert.rejects(client.call({...redeemPermission(expired,noop),account:sponsor}),/revert/i);
    const wrongChain=await sign('wrong-chain',noop);wrongChain.signature=await user.signTypedData({...permissionTypedData(wrongChain),domain:{...permissionTypedData(wrongChain).domain,chainId:1}});
    await assert.rejects(client.call({...redeemPermission(wrongChain,noop),account:sponsor}),/revert/i);
    // The installed Anvil does not enforce Monad's native reserve rule; that gate belongs to Testnet.
    // Locally verify the account's own value binding, independently of any balance rule.
    const zeroValue = await sign('zero-value', noop);
    await assert.rejects(client.call({...redeemPermission(zeroValue,[{...noop[0]!,value:1n}]),account:sponsor}),/revert/i);
  } finally {process.kill('SIGTERM');}
});
