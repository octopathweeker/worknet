import {monadTestnet} from 'viem/chains';
import React,{useEffect,useState} from 'react';
import {createPublicClient,http,formatEther,type Address} from 'viem';
import {agentSessionPermission,permissionTypedData,hashDelegation,delegatedImplementation,AGENT_SESSION_CALLS} from '@agent-task/accounts';
import {t as tr,locale} from './i18n';
import {useToast} from './Toast';
import {meraFailureMessage} from './mera-account';

export function pendingAgentId(){const route=location.hash.match(/^#\/?taker\/executors\/([0-9a-f-]{36})\/?$/i);return route?.[1]?.toLowerCase();}
async function api(path:string,body:unknown){const response=await fetch(`/platform/taker${path}`,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error),{code:value.code});return value;}
export function AgentOnboarding({id,owner,wallet,restoreAccount,createAccount,config}:{id:string;owner:Address|undefined;wallet:(expected?:Address)=>Promise<any>;restoreAccount:()=>unknown;createAccount:()=>unknown;config:any}){
  const [enrollment,setEnrollment]=useState<any>(),[busy,setBusy]=useState(false),[balance,setBalance]=useState<string>(),[error,setError]=useState<{message:string;code?:string}>(),[reload,setReload]=useState(0);const toast=useToast();
  useEffect(()=>{setEnrollment(undefined);setBalance(undefined);setError(undefined);if(owner){let alive=true;void api('/agent/inspect',{id}).then(v=>{if(alive)setEnrollment(v);}).catch(e=>{if(alive)setError({message:e.message,code:e.code});});return()=>{alive=false;};}},[id,owner,reload]);
  const grant=enrollment?.grant, ended=enrollment?.state==='expired'||enrollment?.state==='revoked';
  async function approve(){if(!owner||busy||ended)return;setBusy(true);try{
    const g=await api('/agent/prepare',{id});
    if(g.owner!==owner.toLowerCase()||g.signer!==enrollment?.signer||g.manager.toLowerCase()!==config.manager.toLowerCase()||g.chainId!==10143||g.maxCalls!==AGENT_SESSION_CALLS||g.implementation.toLowerCase()!==delegatedImplementation.toLowerCase())throw new Error('AGENT_GRANT_INVALID');
    const expected=agentSessionPermission(owner,g.signer,config.manager,id,g.validUntil);
    if(hashDelegation(expected)!==hashDelegation(g.permission))throw new Error('AGENT_GRANT_INVALID');
    const {client}=await wallet(owner);const signature=await client.signTypedData(permissionTypedData(expected));let authorization;
    if(g.activationRequired){const signed=await client.signAuthorization({contractAddress:delegatedImplementation,chainId:10143,nonce:g.nonce,executor:g.signer});authorization={address:signed.address,chainId:10143,nonce:signed.nonce,r:signed.r,s:signed.s,yParity:signed.yParity};}
    await api('/agent/approve',{id,signature,...(authorization?{authorization}:{})});setReload(n=>n+1);toast.success('Agent 已获授权。补充执行 gas 后，即可自主接单。');
  }catch(e){setReload(n=>n+1);toast.error(meraFailureMessage(e));}finally{setBusy(false);}}
  async function checkBalance(){if(!enrollment?.signer||!config?.rpcWalletUrl)return;setBusy(true);try{const client=createPublicClient({chain:monadTestnet,transport:http(config.rpcWalletUrl)});setBalance(formatEther(await client.getBalance({address:enrollment.signer})));}catch(e){toast.error(meraFailureMessage(e));}finally{setBusy(false);}}
  function copy(value:string){void navigator.clipboard.writeText(value).then(()=>toast.success('地址已复制。')).catch(()=>toast.error('复制未完成，请选中地址手动复制。'));}
  return <section className="agent-onboarding" aria-label={tr('Agent 账户')}><div className="agent-account-heading"><h2>{tr('Agent 账户')}</h2><button className="text-button" onClick={()=>void navigator.clipboard.writeText(`${location.origin}/#/taker/executors/${id}`).then(()=>toast.success('账户链接已复制，可收藏后再次打开。')).catch(()=>toast.error('复制未完成，请复制浏览器地址。'))}>{tr('复制账户链接')}</button></div>
    <p>{tr('此链接可以重复打开。返回时请使用原通行密钥，无需重新开户。')}</p>
    {!owner?<><button className="button primary" onClick={()=>void restoreAccount()}>{tr('用原通行密钥进入')}</button><details><summary>{tr('这是首次开户')}</summary><p>{tr('仅第一次使用时创建新账户；新通行密钥无法恢复原账户。')}</p><button className="button subtle" onClick={()=>void createAccount()}>{tr('为 Agent 创建新账户')}</button></details></>
    :error?<div className="platform-alert error" role="alert"><p>{tr(error.message)}</p><div className="platform-actions"><button className="button primary" onClick={()=>void restoreAccount()}>{tr('切换到原通行密钥')}</button><button className="button subtle" onClick={()=>setReload(n=>n+1)}>{tr('重新读取账户')}</button></div></div>
    :!enrollment?<p role="status">{tr('正在读取 Agent 账户…')}</p>
    :<><h3>{enrollment.name}</h3><p role="status">{tr(enrollment.state==='revoked'?'此授权已停止':enrollment.state==='expired'?'此授权已到期':enrollment.approved?'账户已开通':'待确认首次授权')}{enrollment.approved&&<> · {tr('有效至 {0}',[new Date(enrollment.expiresAt).toLocaleString(locale())])}</>}</p>
      {ended&&<div className="agent-account-status"><p>{tr('账户记录和地址仍可查看，但这份授权不能继续接单。让本地 Agent 运行 renew，保留执行地址和余额，并重新用原通行密钥确认。')}</p>{enrollment.newerId&&<a href={`#/taker/executors/${enrollment.newerId}`}>{tr('打开当前有效的账户授权')}</a>}</div>}
      {grant?.approved?<><div className="agent-address-grid"><section><h3>{tr('补充 gas · test MON')}</h3><p>{tr('日常只需给这个执行地址补充 MON，供 Agent 支付接单和提交手续费。')}</p><code>{enrollment.signer}</code><button className="button subtle" onClick={()=>copy(enrollment.signer)}>{tr('复制 gas 充值地址')}</button>{!ended&&<a className="text-button" href="https://faucet.monad.xyz/" target="_blank" rel="noreferrer">{tr('前往 Monad 水龙头')}</a>}<button className="text-button" disabled={busy||!config?.rpcWalletUrl} onClick={()=>void checkBalance()}>{tr('检查 gas 余额')}</button>{balance!==undefined&&<p role="status">{balance} test MON</p>}</section>
      <section><h3>{tr('领取奖励 · Mera 账户')}</h3><p>{tr('任务奖励自动进入这个账户，由你的原通行密钥控制。')}</p><code>{grant.owner}</code><button className="button subtle" onClick={()=>copy(grant.owner)}>{tr('复制奖励收款地址')}</button></section></div>
      <p>{tr('接单无需充值发布任务预算，也无需向平台执行器转账。')}</p>{!ended&&<details><summary>{tr('授权详情与恢复')}</summary><p>{tr('有效期 7 天，最多 200 次链上领取或提交。执行密钥不能转走收款账户的资产；到期或扩大权限时需重新确认。')}</p><p>{tr('仅当本地 Agent 提示账户激活授权失效时，才需要在这里重新确认；不会延长有效期或增加调用次数。')}</p><button className="button subtle" disabled={busy||!config} onClick={()=>void approve()}>{tr('恢复账户激活授权')}</button></details>}</>
      :!ended&&<><p>{tr('确认后 Agent 可自主接单，首次设置无需给发布任务预算充值。')}</p><dl><dt>{tr('将使用的 Mera 收款账户')}</dt><dd><code>{owner}</code></dd><dt>{tr('本地执行地址 · 请与 Agent 显示的地址核对')}</dt><dd><code>{enrollment.signer}</code></dd></dl><p>{tr('有效期 7 天，最多 200 次链上领取或提交。执行密钥不能转走收款账户的资产；到期或扩大权限时需重新确认。')}</p><button className="button primary" disabled={busy||!config} onClick={()=>void approve()}>{busy?tr('正在处理，请保留当前操作…'):tr('确认并启用自主接单')}</button>{!enrollment.owner&&<details><summary>{tr('需要使用其他账户')}</summary><button className="button subtle" disabled={busy} onClick={()=>void restoreAccount()}>{tr('切换到原通行密钥')}</button><button className="button subtle" disabled={busy} onClick={()=>void createAccount()}>{tr('为 Agent 创建新账户')}</button></details>}</>}
    </>}
  </section>;
}
