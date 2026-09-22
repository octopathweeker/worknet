import { useToast } from './Toast';
import {LanguageSwitcher} from './LanguageSwitcher';
import {t as tr,locale} from './i18n';
import React, { useEffect, useRef, useState } from 'react';
import { createWalletClient, createPublicClient, custom, defineChain, http, erc20Abi, parseUnits, type Address, type EIP1193Provider } from 'viem';
import { requesterVaultAbi } from '@agent-task/contracts';
import type { GoalInput, GoalView, WorkspaceSnapshot, WorkspaceCommand, CommandReply, WorkerView } from '@agent-task/workspace';
import { Brand, Dialog, Icon, Money, formatMoney, relative, short } from './components';
import { legacyHash, readLegacyHash, useLegacyRoute } from './hash-route';
declare global { interface Window { ethereum?: EIP1193Provider } }
type View = 'home' | 'deliveries' | 'workers' | 'settings';
const examples = [
  { title: '研究 Monad 的 Agent 基础设施', goal: '比较 Monad 上的 ERC-8004 身份与 MPP 支付分别解决什么问题，形成有来源引用的研究简报。', kind: 'research' },
  { title: '了解最新的 USDC 转账情况', goal: '统计最近 100 个已确认区块中的测试 USDC 转账次数和总金额，给出可复核的结果。', kind: 'analysis' },
  { title: '交给一个研究小组', goal: '研究 Monad 的 Agent 身份和支付机制，同时分析最近的测试 USDC 转账，分别提交资料简报和数据报告。', kind: 'team' },
] as const;
async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(route, { credentials: 'same-origin', signal: AbortSignal.timeout(20000), ...init });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? '连接暂时不可用，请稍后再试。'); return data as T;
}
async function send(command: WorkspaceCommand): Promise<any> {
  let response = await request<CommandReply>('/workspace/commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) });
  const deadline = Date.now() + 125000;
  while (response.status === 'queued') {
    if (Date.now() > deadline) throw new Error('操作仍在处理中。请稍后刷新；继续原计划不会重复创建已发布的任务。');
    await new Promise(r => setTimeout(r, 1200)); response = await request<CommandReply>(`/workspace/commands/${command.id}`);
  }
  if (response.status === 'failed') throw new Error(response.error ?? '这次操作没有完成，请重试原计划。');
  return response.result;
}
function statusOf(goal: GoalView) {
  if (goal.status === 'draft') return '等待确认';
  if (goal.status === 'completed') return '已完成';
  if (goal.status === 'attention') return '需要关注';
  if (goal.tasks.some(t => t.status === 2)) return '交付审核中';
  if (goal.tasks.some(t => t.status === 1)) return 'Agent 正在处理';
  return '等待 Agent 接单';
}
function total(goal: GoalView) { return goal.tasks.reduce((sum, task) => sum + BigInt(task.reward), 0n).toString(); }
const quoteText = (value: unknown) => String(value ?? '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
const safeLink = (value: unknown) => { try { const u = new URL(String(value)); return u.protocol === 'https:' && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } };

function readDraft(): { goal: string; kind: GoalInput['kind']; sources: string; fromBlock: string; toBlock: string } {
  try {
    const value = JSON.parse(sessionStorage.getItem('worknet.inputDraft') ?? '{}');
    return { goal: typeof value.goal === 'string' ? value.goal : sessionStorage.getItem('worknet.goalDraft') ?? '', kind: ['research','analysis','team'].includes(value.kind) ? value.kind as GoalInput['kind'] : 'research' as const, sources: typeof value.sources === 'string' ? value.sources : '', fromBlock: typeof value.fromBlock === 'string' ? value.fromBlock : '', toBlock: typeof value.toBlock === 'string' ? value.toBlock : '' };
  } catch { return { goal: '', kind: 'research' as const, sources: '', fromBlock: '', toBlock: '' }; }
}
export default function App() {
  const [view, setView] = useState<View>(() => readLegacyHash().view); const [authenticated, setAuthenticated] = useState(false); const [checked, setChecked] = useState(false);
  const route = useLegacyRoute();
  useEffect(() => {
    setSelected(previous => (previous === route.goal ? previous : route.goal));
    if (route.view !== view) setView(route.view);
  }, [route]);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(); const [publicConfig, setPublicConfig] = useState<any>(); const [login, setLogin] = useState(false);
  const [code, setCode] = useState(''); const [loginError, setLoginError] = useState(''); const toast = useToast(); const [goalError, setGoalError] = useState(''); const [syncError, setSyncError] = useState('');
  const [draft] = useState(readDraft);
  const [goal, setGoal] = useState(draft.goal); const [kind, setKind] = useState<GoalInput['kind']>(draft.kind);
  const [sources, setSources] = useState(draft.sources); const [fromBlock, setFromBlock] = useState(draft.fromBlock); const [toBlock, setToBlock] = useState(draft.toBlock);
  const [busy, setBusy] = useState(''); const [selected, setSelected] = useState<string | undefined>(() => readLegacyHash().goal); const [plan, setPlan] = useState<GoalView>(); const [workerBusy, setWorkerBusy] = useState('');
  const [amount, setAmount] = useState('2'); const [wallet, setWallet] = useState<Address>();
  const planIntent = useRef<{ fingerprint: string; id: string } | undefined>(undefined); const inputRef = useRef<HTMLTextAreaElement>(null);
  const connection = useRef(false);
  const refresh = async () => {
    try {
      const session = await request<{ authenticated: boolean }>('/workspace/session'); setAuthenticated(session.authenticated); connection.current = session.authenticated;
      if (session.authenticated) { const data = await request<WorkspaceSnapshot>('/workspace/state'); setSnapshot(data); setPublicConfig(data.config); setSyncError(''); }
      else setSnapshot(undefined);
    } catch (e) { if (connection.current) { setSyncError('同步暂时中断，正在自动重连。你输入的目标会保留。'); setSnapshot(previous => previous ? { ...previous, connected: false } : previous); } }
    finally { setChecked(true); }
  };
  useEffect(() => { void request('/api/config').then(setPublicConfig).catch(() => undefined); void refresh(); const timer = setInterval(() => { void refresh(); }, 4000); return () => clearInterval(timer); }, []);
  useEffect(() => { try { sessionStorage.setItem('worknet.inputDraft', JSON.stringify({ goal, kind, sources, fromBlock, toBlock })); sessionStorage.removeItem('worknet.goalDraft'); } catch {} }, [goal, kind, sources, fromBlock, toBlock]);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [view, selected]);
  const goals = snapshot?.goals ?? []; const current = goals.find(g => g.id === selected) ?? (plan?.id === selected ? plan : undefined);
  const openView = (next: View) => { location.hash = legacyHash({ view: next }); setGoalError(''); };
  const openGoal = (id: string) => { location.hash = legacyHash({ view, goal: id }); };
  const newGoal = () => { setPlan(undefined); planIntent.current = undefined; setGoal(''); setSources(''); setFromBlock(''); setToBlock(''); setGoalError(''); location.hash = legacyHash({ view: 'home' }); setTimeout(() => inputRef.current?.focus(), 0); };
  const connect = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy('login'); setLoginError('');
    try { await request('/workspace/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }); setCode(''); setLogin(false); setAuthenticated(true); connection.current = true; await refresh(); toast.success('已连接工作区，可以创建真实任务了。'); }
    catch (e) { setLoginError((e as Error).message); } finally { setBusy(''); }
  };
  const makePlan = async (event: React.FormEvent) => {
    event.preventDefault(); toast.clear(); setGoalError('');
    if (!authenticated) { setLogin(true); return; }
    if (goal.trim().length < 8) { setGoalError('请再具体一点：希望得到什么结果？至少输入 8 个字。'); inputRef.current?.focus(); return; }
    setBusy('plan');
    try {
      const input: GoalInput = { goal: goal.trim(), kind, sourceUrls: sources.split(/\n/).map(s => s.trim()).filter(Boolean), ...(fromBlock ? { fromBlock } : {}), ...(toBlock ? { toBlock } : {}) };
      const fingerprint = JSON.stringify(input); if (planIntent.current?.fingerprint !== fingerprint) planIntent.current = { fingerprint, id: crypto.randomUUID() };
      const result = await send({ id: planIntent.current.id, type: 'plan', input }); setPlan(result); openGoal(result.id); await refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(''); }
  };
  const launch = async (item: GoalView) => {
    setBusy('launch'); setGoalError(''); toast.clear();
    try { await send({ id: crypto.randomUUID(), type: 'launch', goalId: item.id }); setPlan(undefined); openGoal(item.id); setGoal(''); setSources(''); setFromBlock(''); setToBlock(''); planIntent.current = undefined; await refresh(); toast.success('任务已发布。你可以留在这里查看进度，也可以稍后回来。'); window.scrollTo({ top: 0 }); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(''); }
  };
  const toggleWorker = async (worker: WorkerView) => {
    setWorkerBusy(worker.address); setGoalError(''); toast.clear();
    try { await send({ id: crypto.randomUUID(), type: 'worker-control', address: worker.address, accepting: !worker.accepting }); await refresh(); toast.success(worker.accepting ? '已暂停新接单，当前任务会继续完成。' : '已恢复接单。'); }
    catch (e) { toast.error((e as Error).message); } finally { setWorkerBusy(''); }
  };
  const walletAction = async (action: 'connect' | 'deposit' | 'authorize' | 'revoke') => {
    setBusy(action); setGoalError(''); toast.clear();
    try {
      const c = publicConfig; if (!window.ethereum || !c) throw new Error('请在安装 EVM 钱包的浏览器中操作预算。');
      const chain = defineChain({ id: c.chainId, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [c.rpcWalletUrl] } } });
      const signer = createWalletClient({ chain, transport: custom(window.ethereum) }); const [account] = await signer.requestAddresses(); if (!account) throw new Error('钱包未连接。'); setWallet(account); if (action === 'connect') return;
      if (account.toLowerCase() !== c.owner.toLowerCase()) throw new Error('请使用当前工作区的 Owner 钱包。');
      if (await signer.getChainId() !== c.chainId) throw new Error(`请切换钱包到 Monad Testnet（${c.chainId}）。`);
      const read = createPublicClient({ chain, transport: http() });
      if (action !== 'revoke' && !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(amount)) throw new Error('请输入有效额度，最多 6 位小数。');
      const value = action === 'revoke' ? 0n : parseUnits(amount, 6); if (action !== 'revoke' && value <= 0n) throw new Error('额度必须大于零。');
      const confirm = async (hash: `0x${string}`) => { if ((await read.waitForTransactionReceipt({ hash })).status !== 'success') throw new Error('钱包操作未成功，请检查交易记录。'); };
      if (action === 'deposit') { await confirm(await signer.writeContract({ account, address: c.token, abi: erc20Abi, functionName: 'approve', args: [c.vault, value] })); await confirm(await signer.writeContract({ account, address: c.vault, abi: requesterVaultAbi, functionName: 'deposit', args: [value] })); }
      else if (action === 'authorize') { const now = (await read.getBlock()).timestamp; await confirm(await signer.writeContract({ account, address: c.vault, abi: requesterVaultAbi, functionName: 'authorizeAgent', args: [c.agent, { validAfter: now, validUntil: now + 86400n, maxPerTask: value < 200000n ? value : 200000n, maxTotalCommitment: value }] })); }
      else await confirm(await signer.writeContract({ account, address: c.vault, abi: requesterVaultAbi, functionName: 'revokeAgent', args: [c.agent] }));
      await refresh(); toast.success('预算操作已确认。');
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(''); }
  };
  return <div className="workspace-shell">
    <aside className="rail"><a href="/" aria-label={tr("Worknet 首页")}><Brand/></a><button className="workspace-picker" onClick={() => authenticated ? openView('settings') : setLogin(true)}><span className="workspace-avatar">W</span><span>{tr("我的工作区")}<small>{authenticated ? tr("个人与团队") : tr("连接后开始工作")}</small></span><Icon name="down" size={16}/></button>
      <button className="new-goal" onClick={newGoal}><Icon name="plus"/>{tr("新建目标")}<span>＋</span></button>
      <nav aria-label={tr("主导航")}>{([['home','goal',tr("我的目标")],['deliveries','file',tr("交付文档")],['workers','worker',tr("Worker 工作室")]] as const).map(([id, icon, title]) => <button key={id} className={view === id ? 'active' : ''} onClick={() => openView(id)} aria-current={view === id ? 'page' : undefined}><Icon name={icon}/>{title}{id === 'deliveries' && goals.filter(g => g.status === 'completed').length > 0 && <span className="nav-count">{goals.filter(g => g.status === 'completed').length}</span>}</button>)}</nav>
      <div className="rail-bottom"><div className="connection-card"><span className={`status-dot ${snapshot?.connected ? 'online' : ''}`}/><div>{authenticated ? snapshot?.connected ? tr("工作区已连接") : tr("执行服务离线") : tr("尚未连接工作区")}<small>{authenticated ? tr("你的 Agent 在本机运行") : tr("用访问码连接现有团队")}</small></div></div><button onClick={() => openView('settings')} className={view === 'settings' ? 'settings-link active' : 'settings-link'}><Icon name="settings"/>{tr("预算与设置")}</button><a className="resources-link" href="https://hackathon.monad.xyz/resources" target="_blank" rel="noreferrer">Monad resources<Icon name="link" size={14}/></a></div>
    </aside>
    <main className="workspace-main"><header className="topbar"><div><span className="mobile-brand"><Brand/></span><span className="breadcrumb">{tr("我的工作区")}<span>/</span> {current ? tr("目标详情") : ({home:tr("我的目标"),deliveries:tr("交付文档"),workers:tr("Worker 工作室"),settings:tr("预算与设置")})[view]}</span></div><div className="top-actions"><LanguageSwitcher/><span className="testnet-label">Monad Testnet</span><button aria-label={authenticated ? tr("工作区设置") : tr("连接工作区")} className={authenticated ? 'account-button' : 'button subtle'} onClick={() => authenticated ? openView('settings') : setLogin(true)}>{authenticated ? <span className="user-avatar">W</span> : <>{tr("连接工作区")}<Icon name="link" size={16}/></>}</button></div></header>
      <div className="page-body">
        {syncError && <div className="feedback error" role="status"><Icon name="link"/><span>{tr(syncError)}</span></div>}
        {current ? <GoalDetail goal={current} busy={busy === 'launch'} connected={Boolean(snapshot?.connected)} onBack={() => { location.hash = legacyHash({ view }); }} onLaunch={() => void launch(current)} onReuse={() => { setGoal(current.input.goal); setKind(current.input.kind); setSources(current.input.sourceUrls.join('\n')); setFromBlock(current.input.fromBlock ?? ''); setToBlock(current.input.toBlock ?? ''); planIntent.current = undefined; setPlan(undefined); location.hash = legacyHash({ view: 'home' }); }} /> : <>
          {view === 'home' && <><section className="home-heading"><div className="heading-symbol"><Icon name="spark" size={28}/></div><h1>{tr("下一件事，交给你的团队。")}</h1><p>{tr("告诉我们你想得到什么。先确认计划，再让 Agent 开始工作。")}</p></section>
            <div className="creation-layout"><form className="goal-composer" onSubmit={e => void makePlan(e)}><label className="composer-label" htmlFor="goal-input">{tr("你想完成什么？")}</label><textarea ref={inputRef} id="goal-input" value={goal} aria-invalid={!!goalError} aria-describedby={goalError ? "goal-error" : undefined} onChange={e => { setGoal(e.target.value); setGoalError(''); }} placeholder={tr("例如：比较 Monad 的 Agent 身份与支付机制，整理一份附来源的研究简报。")} maxLength={2000} rows={4}/>{goalError && <p id="goal-error" className="field-error" role="alert">{tr(goalError)}</p>}<div className="composer-options"><label className="kind-select"><Icon name={kind === 'analysis' ? 'grid' : kind === 'team' ? 'worker' : 'file'} size={17}/><select aria-label={tr("工作类型")} value={kind} onChange={e => setKind(e.target.value as GoalInput['kind'])}><option value="research">{tr("资料研究")}</option><option value="analysis">{tr("链上分析")}</option><option value="team">{tr("研究小组")}</option></select></label><span>{tr("研究简报与转账分析")}</span></div>
              <details className="source-settings"><summary><Icon name="link" size={16}/>{tr("调整资料范围与分析区间")}<Icon name="down" size={14}/></summary><div className="source-fields">{kind !== 'analysis' && <label>{tr("公开资料地址")}<textarea value={sources} onChange={e => setSources(e.target.value)} rows={3} placeholder={tr("每行一个 HTTPS 地址，最多 3 个。留空使用 Monad 的身份与支付官方资料。")}/><small>{tr("Agent 只使用这些资料；内容不足会在交付中说明。")}</small></label>}{kind !== 'research' && <div className="field-pair"><label>{tr("起始区块")}<input value={fromBlock} onChange={e => setFromBlock(e.target.value)} inputMode="numeric" placeholder={tr("默认最近 100 个区块")}/></label><label>{tr("结束区块")}<input value={toBlock} onChange={e => setToBlock(e.target.value)} inputMode="numeric" placeholder={tr("默认最新已确认区块")}/></label></div>}</div></details>
              <div className="composer-footer"><span><Icon name="check" size={14}/>{tr("确认计划前不会支付")}</span><button className="button primary" disabled={!!busy || !checked || !goal.trim()} type="submit">{busy === 'plan' ? <><span className="spinner"/>{tr("正在准备计划")}</> : <>{tr("生成执行计划")}<Icon name="arrow" size={18}/></>}</button></div></form>
              <aside className="outcome-note"><div className="paper-stack"><div className="paper-back"/><div className="paper-front"><span className="paper-mark"><Icon name="file" size={25}/></span><b>{tr("从目标到交付")}</b><i/><i/><i/><span className="paper-check"><Icon name="check" size={14}/>{tr("有依据的结果")}</span></div></div><p>{tr("你提出目标，Agent 负责执行。")}<br/>{tr("计划、进度与交付，都在一个地方。")}</p></aside></div>
            <section className="starter-section"><div className="section-heading"><h2>{tr("从这些目标开始")}</h2><span>{tr("可编辑后再生成计划")}</span></div><div className="starter-grid">{examples.map((item, i) => <button key={item.kind} className="starter" onClick={() => { setGoal(item.goal); setKind(item.kind); setSources(''); setFromBlock(''); setToBlock(''); inputRef.current?.focus(); }}><span className={`starter-icon tone-${i}`}><Icon name={['file','grid','worker'][i]!}/></span><strong>{tr(item.title)}</strong><Icon name="arrow" size={17}/></button>)}</div></section>
            <section className="recent-section"><div className="section-heading"><h2>{tr("最近的目标")}</h2><span>{goals.length ? tr("{0} 个目标",[goals.length]) : tr("你的下一份交付从这里开始")}</span></div><GoalList goals={goals.slice(0,8)} onOpen={openGoal}/></section></>}
          {view === 'deliveries' && <><PageHeading title={tr("交付，值得好好阅读。")} description={tr("结论、数据与来源放在一起。每份文档都保留执行与审核记录。")}/><div className="document-list">{goals.filter(g => g.status === 'completed' || g.status === 'attention').map(g => <button className="document-tile" key={g.id} onClick={() => openGoal(g.id)}><div className="document-cover"><Icon name="file" size={36}/><span>{g.tasks.length}{tr("份交付")}</span></div><div><span className={`pill ${g.status}`}>{tr(statusOf(g))}</span><h2>{g.title}</h2><p>{relative(g.createdAt)}{tr("· 查看结论与引用")}</p></div><Icon name="chevron"/></button>)}</div>{!goals.some(g=>g.status==='completed'||g.status==='attention') && <Empty icon="file" title={tr("交付完成后，会整理在这里")} description={tr("从一个研究或分析目标开始，你会得到可阅读的结果和可追溯的依据。")} action={<button className="button primary" onClick={newGoal}>{tr("创建第一个目标")}</button>}/>}</>}
          {view === 'workers' && <><PageHeading title={tr("你的执行团队。")} description={tr("掌握每个 Worker 的状态，按需要暂停或恢复接单。")}/><div className="workers-intro"><Icon name="worker"/><span>{snapshot?.workers.filter(w=>w.online).length ?? 0}{tr("个在线 Worker")}</span><span>{tr("暂停接单后，已经领取的任务仍会继续完成。")}</span></div><div className="worker-grid">{snapshot?.workers.map(worker => <WorkerCard key={worker.address} worker={worker} busy={workerBusy === worker.address} onToggle={() => void toggleWorker(worker)}/>)}</div>{!snapshot?.workers.length && <Empty icon="worker" title={authenticated ? tr("等待 Worker 连接") : tr("连接你的工作区")} description={authenticated ? tr("本机服务启动后，独立 Worker 会自动出现在这里。") : tr("连接后可以查看真实 Worker 的状态、任务和收益。")} action={!authenticated && <button className="button primary" onClick={() => setLogin(true)}>{tr("连接工作区")}</button>}/>}</>}
          {view === 'settings' && <><PageHeading title={tr("让自主执行，有清晰边界。")} description={tr("管理团队访问和任务预算。每一次执行都先经过你的确认。")}/><section className="settings-panel"><div><h2>{tr("工作区连接")}</h2><p>{snapshot?.connected ? tr("执行服务在线，可以创建任务和管理 Worker。") : authenticated ? tr("已登录，但本机执行服务尚未连接。") : tr("用现有工作区的访问码连接执行服务。")}</p></div>{authenticated ? <button className="button subtle" onClick={() => { void request('/workspace/logout', {method:'POST'}).then(() => {setAuthenticated(false); setSnapshot(undefined); connection.current=false;}); }}><Icon name="logout" size={16}/>{tr("断开登录")}</button> : <button className="button primary" onClick={() => setLogin(true)}>{tr("连接工作区")}</button>}</section>
            <section className="budget-settings"><div className="section-heading"><h2>{tr("任务预算")}</h2><span>{tr("测试资产，没有真实货币价值")}</span></div><div className="budget-metrics"><div><span>{tr("可用于新任务")}</span><b><Money amount={snapshot?.budget?.newCommitmentCapacity}/><small>test USDC</small></b></div><div><span>{tr("已承诺的奖励")}</span><b><Money amount={snapshot?.budget?.committed}/><small>test USDC</small></b></div><div><span>{tr("每个任务最多")}</span><b><Money amount={snapshot?.budget?.maxPerTask}/><small>test USDC</small></b></div></div><p className="setting-explanation">{tr("工作区余额与本次授权额度共同限制可用预算。到期或撤销不会取消已经发布的任务。")}</p><div className="wallet-controls"><label>{tr("充值或授权额度")}<input value={amount} onChange={e=>setAmount(e.target.value)} inputMode="decimal"/></label><button className="button subtle" disabled={!!busy} onClick={()=>void walletAction('connect')}>{wallet ? short(wallet) : tr("连接 Owner 钱包")}</button><button className="button subtle" disabled={!!busy} onClick={()=>void walletAction('deposit')}>{tr("充值")}</button><button className="button primary" disabled={!!busy} onClick={()=>void walletAction('authorize')}>{tr("授权 24 小时")}</button><button className="text-button danger" disabled={!!busy} onClick={()=>void walletAction('revoke')}>{tr("撤销授权")}</button></div><details className="technical"><summary>{tr("查看链上账户与授权细节")}</summary><dl><dt>Owner</dt><dd>{publicConfig?.owner}</dd><dt>Requester</dt><dd>{publicConfig?.agent}</dd><dt>Vault</dt><dd>{publicConfig?.vault}</dd><dt>{tr("任务合约")}</dt><dd>{publicConfig?.manager}</dd><dt>{tr("授权到期")}</dt><dd>{snapshot?.budget?.validUntil ? new Date(Number(snapshot.budget.validUntil)*1000).toLocaleString(locale()) : '—'}</dd></dl><p>{tr("重新授权会开启新的授权周期，旧任务由 Owner 接管。")}</p></details></section></>}
        </>}
        <footer className="workspace-footer"><span>{tr("Worknet，让 Agent 为结果协作。")}</span><span>{snapshot?.updatedAt ? tr("最近同步 {0}",[relative(snapshot.updatedAt)]) : tr("基于 Monad 的任务协作")}</span></footer>
      </div>
    </main>
    {login && <Dialog title={tr("连接你的工作区")} onClose={()=>{setLogin(false);setLoginError('');}}><p className="dialog-description">{tr("输入团队的工作区访问码。连接后，你可以创建真实任务、阅读交付并管理 Worker。")}</p><form onSubmit={e=>void connect(e)}><label className="form-label">{tr("工作区访问码")}<input autoFocus type="password" autoComplete="current-password" value={code} onChange={e=>setCode(e.target.value)} placeholder={tr("粘贴工作区访问码")} aria-describedby={loginError ? 'login-error' : 'login-help'}/></label><p id="login-help" className="field-help">{tr("访问码保存在本机 WORKSPACE-ACCESS.md，由工作区管理员提供。")}</p>{loginError&&<p id="login-error" className="field-error" role="alert">{tr(loginError)}</p>}<button className="button primary full-width" disabled={busy==='login'||!code}>{busy==='login'?tr("正在连接…"):tr("连接工作区")}</button></form><div className="login-note"><Icon name="check" size={16}/>{tr("不需要向网页提供钱包私钥")}</div></Dialog>}
  </div>;
}
function PageHeading({title,description}:{title:string;description:string}) { return <div className="page-heading"><h1>{title}</h1><p>{description}</p></div>; }
function Empty({icon,title,description,action}:{icon:string;title:string;description:string;action?:React.ReactNode}) { return <div className="empty-state"><span><Icon name={icon} size={28}/></span><h3>{title}</h3><p>{description}</p>{action}</div>; }
function GoalList({goals,onOpen}:{goals:GoalView[];onOpen(id:string):void}) { return <div className="goal-list">{goals.map(g=><button className="goal-row" key={g.id} onClick={()=>onOpen(g.id)}><span className={`goal-row-icon ${g.status}`}><Icon name={g.status==='completed'?'check':g.status==='draft'?'file':'clock'}/></span><span className="goal-row-copy"><strong>{g.title}</strong><small>{g.tasks.length===2?tr("研究小组"):g.input.kind==='analysis'?tr("链上分析"):tr("资料研究")} · {relative(g.createdAt)}</small></span><span className={`pill ${g.status}`}>{tr(statusOf(g))}</span><Icon name="chevron" size={18}/></button>)}{!goals.length&&<div className="empty-inline"><Icon name="goal"/><span>{tr("还没有目标。描述一件想完成的事，让团队开始工作。")}</span></div>}</div>; }
function WorkerCard({worker,busy,onToggle}:{worker:WorkerView;busy:boolean;onToggle():void}) {
  const research=worker.capability==='research.web';const name=research?'Atlas':'Delta';
  const events:Record<string,string>={'executing':'开始执行任务','submitted':'交付已提交审核','timeout-settlement':'审核超时，已结算','task-error':'执行需要检查','claim-unavailable':'任务已由其他 Worker 领取'};
  return <article className="worker-card"><div className="worker-card-top"><div className={`agent-portrait ${research?'atlas':'delta'}`}><Icon name={research?'spark':'grid'} size={34}/></div><div><h2>{name}</h2><p>{research?tr("资料研究与引用整理"):tr("链上转账数据分析")}</p></div><span className={`pill ${worker.online?'completed':'attention'}`}>{worker.online?tr("在线"):tr("离线")}</span></div><div className="worker-current"><span className={`status-dot ${worker.online&&worker.accepting?'online':''}`}/><div><strong>{worker.phase==='working'?tr("正在处理任务"):!worker.online?tr("尚未连接"):worker.accepting?tr("准备好接收新任务"):tr("已暂停新接单")}</strong><small>{worker.phase==='working'?tr("当前工作会继续完成"):research?tr("使用本机模型执行，独立审核交付"):tr("完整读取固定区间，复算结果")}</small></div></div><div className="worker-stats"><div><b>{worker.completed}</b><span>{tr("已完成任务")}</span></div><div><b><Money amount={worker.earned}/></b><span>{tr("test USDC 收益")}</span></div></div><button className={worker.accepting?'button subtle full-width':'button primary full-width'} onClick={onToggle} disabled={busy||!worker.online}><Icon name={worker.accepting?'pause':'play'} size={16}/>{busy?tr("正在更新…"):worker.accepting?tr("暂停接单"):tr("恢复接单")}</button>{worker.error&&<p className="field-error">{tr("执行器报告异常，请检查本机服务日志。")}</p>}<details className="worker-history"><summary>{tr("运行记录与账户")}<Icon name="down" size={14}/></summary><div className="worker-events">{worker.recent.slice(0,5).map((e,i)=><p key={i}><span>{tr(events[e.event])||tr("状态已更新")}</span><time>{relative(e.at)}</time></p>)}{!worker.recent.length&&<p>{tr("等待第一次执行。")}</p>}</div><dl><dt>{tr("执行账户")}</dt><dd>{short(worker.address)}</dd><dt>{tr("Gas 余额")}</dt><dd>{(Number(BigInt(worker.gasBalance))/1e18).toFixed(3)} test MON</dd></dl></details></article>;
}
function GoalDetail({goal,busy,connected,onBack,onLaunch,onReuse}:{goal:GoalView;busy:boolean;connected:boolean;onBack():void;onLaunch():void;onReuse():void}) {
  const draft=goal.status==='draft';
  return <section className="goal-detail"><button className="back-button" onClick={onBack}><span>‹</span>{tr("返回我的目标")}</button><div className="detail-heading"><span className={`pill ${goal.status}`}>{tr(statusOf(goal))}</span><h1>{goal.title}</h1><p>{draft?tr("这份计划还未执行。确认下面的工作和预算，再交给团队。"):tr("创建于 {0} · {1} 项工作",[new Date(goal.createdAt).toLocaleString(locale()),goal.tasks.length])}</p></div>
    {draft||goal.status==='launching'||goal.tasks.some(t=>!t.taskId)?<div className="plan-layout"><div className="plan-paper"><h2>{tr("团队会这样完成目标")}</h2>{goal.tasks.map((task,i)=><div className="plan-step" key={task.kind}><span className="step-number">{i+1}</span><div><h3>{task.title}</h3><p>{task.description}</p><small>{task.kind==='research'?tr("Atlas · 研究 Agent"):tr("Delta · 分析 Agent")}</small></div><span><Money amount={task.reward}/> <small>test USDC</small></span></div>)}{goal.input.sourceUrls.length>0&&<div className="plan-sources"><h3>{tr("参考资料")}</h3>{goal.input.sourceUrls.map(uri=><a href={safeLink(uri)} target="_blank" rel="noreferrer" key={uri}><Icon name="link" size={14}/>{uri}</a>)}</div>}<p className="plan-disclosure">{tr("任务内容和交付会写入公开内容存储。请使用公开资料。")}</p></div><aside className="plan-confirm"><Icon name="wallet" size={24}/><h2>{tr("确认这次执行")}</h2><div className="plan-price"><Money amount={total(goal)}/><span>test USDC</span></div><p>{goal.tasks.length}{tr("个任务的总奖励，分项审核与结算。")}</p><ul><li><Icon name="check" size={14}/>{tr("逐项审核与结算")}</li><li><Icon name="check" size={14}/>{tr("无人完成会退还托管奖励")}</li><li><Icon name="clock" size={14}/>{tr("通常需要 1–3 分钟")}</li></ul><button className="button primary full-width" onClick={onLaunch} disabled={busy||!connected}>{busy?<><span className="spinner"/>{tr("正在发布任务")}</>:<>{tr("确认并开始")}<Icon name="arrow" size={17}/></>}</button>{!connected&&<p className="field-error">{tr("执行服务离线，连接后可继续。")}</p>}<button className="text-button full-width" onClick={onReuse}>{tr("调整目标并重新规划")}</button><small>{tr("审核窗口结束后仍可能超时结算，此类交付会明确标注。")}</small></aside></div>:<>
      <div className="execution-progress">{[[tr("已确认计划"),true],[tr("Agent 执行"),goal.tasks.some(t=>t.status!==0)],[tr("独立审核"),goal.tasks.some(t=>(t.status??0)>=2)],[tr("交付结果"),goal.status==='completed']].map(([label,done],i)=><div key={String(label)} className={done?'done':''}><span>{done?<Icon name="check" size={14}/>:i+1}</span><b>{label}</b></div>)}</div>
      {goal.status==='attention'&&<div className="attention-note"><Icon name="warning"/><div><h3>{tr("这次执行需要你留意")}</h3><p>{goal.error??tr("部分任务已过期、取消或未经审核就超时结算，请查看每项工作的记录。")}</p><button className="text-button" onClick={onReuse}>{tr("以此目标重新规划")}</button></div></div>}
      <div className="deliverables">{goal.tasks.map(task=><article className="deliverable" key={task.kind}><div className="deliverable-head"><span className="deliverable-icon"><Icon name={task.kind==='research'?'file':'grid'}/></span><div><h2>{task.kind==='research'?tr("研究简报"):tr("链上数据报告")}</h2><p>{task.kind==='research'?'Atlas':'Delta'}{tr("负责交付")}</p></div><span className={`pill ${task.status===3?'completed':''}`}>{([tr("等待接单"),tr("执行中"),tr("审核中"),tr("已结算"),tr("已取消"),tr("已过期")])[task.status??0]}</span></div>{task.result?<ResultDocument task={task}/>:<div className="waiting-result"><span className="progress-orbit"><Icon name={task.status===2?'check':'worker'} size={24}/></span><h3>{task.status===0?tr("等待合适的 Agent 接单"):task.status===2?tr("正在独立审核结果"):tr("Agent 正在为这个目标工作")}</h3><p>{task.status===0?tr("可以在 Worker 工作室检查接单状态。"):tr("结果准备好后会出现在这里，你无需一直停留。")}</p></div>}<details className="technical"><summary>{tr("执行与验证记录")}<Icon name="down" size={14}/></summary><dl><dt>{tr("任务")}</dt><dd>#{task.taskId}{tr("/ 第")}{task.attempt??'0'}{tr("轮")}</dd><dt>{tr("执行账户")}</dt><dd>{task.worker??tr("等待分配")}</dd></dl>{task.verification?.map((e,i)=><div key={i} className="verification-group"><strong>{tr("第")}{e.attempt}{tr("轮：")}{e.verdict==='accept'?tr("检查通过"):e.verdict==='reject'?tr("结果已拒绝"):tr("暂时无法验证")}</strong>{e.checks.map((check:any,j:number)=><p key={j}><Icon name={check.passed?'check':'warning'} size={14}/>{check.name}</p>)}</div>)}{task.events?.map((e,i)=><a className="event-link" key={i} href={`https://testnet.monadscan.com/tx/${e.transactionHash}`} target="_blank" rel="noreferrer">{e.eventName}<span>{short(e.transactionHash)}<Icon name="link" size={13}/></span></a>)}<details><summary>{tr("原始交付数据")}</summary><pre>{JSON.stringify(task.result,null,2)}</pre></details></details></article>)}</div>
    </>}
  </section>;
}
function ResultDocument({task}:{task:GoalView['tasks'][number]}) {
  const output=(task.result as {output?:any})?.output;
  const verified=task.verification?.some(e=>e.attempt===task.attempt&&e.resultHash===task.resultHash&&e.verdict==='accept');
  const timeout=task.events?.some(e=>e.eventName==='TaskSettled'&&Number(e.args.reason)===1);
  if (!output||typeof output!=='object') return <p className="field-error">{tr("交付格式无法显示，请检查执行记录。")}</p>;
  return <div className="result-document">{timeout&&<p className="document-warning">{tr("此任务因审核超时而结算，结果未获得验证通过。")}</p>}{verified&&<div className="document-verified"><Icon name="check" size={15}/>{tr("独立检查通过")}</div>}{task.kind==='research'?<><p className="research-summary">{typeof output.summary==='string'?output.summary:tr("研究结果已提交。")}</p>{Array.isArray(output.findings)&&output.findings.map((f:any,i:number)=><section className="finding" key={i}><h3>{String(f.title??tr("结论 {0}",[i+1]))}</h3><p>{String(f.claim??'')}</p><blockquote>{quoteText(f.quote)}</blockquote><a href={safeLink(f.sourceUri)} target="_blank" rel="noreferrer"><Icon name="link" size={13}/>{safeLink(f.sourceUri)?new URL(f.sourceUri).hostname:tr("来源")}<span>{tr("查看原文")}</span></a></section>)}</>:<><h3>{tr("区间转账概览")}</h3>{String(output.eventCount)==='0'&&<p>{tr("这个区间内没有检测到测试 USDC 转账。")}</p>}<div className="analysis-result"><div><span>{tr("转账次数")}</span><strong>{String(output.eventCount??'—')}</strong></div><div><span>{tr("累计转账金额")}</span><strong>{formatMoney(String(output.totalAmountBaseUnits??'0'))}<small>test USDC</small></strong></div></div><p>{tr("对固定区块内的全部 Transfer 事件进行统计，并由另一条读取路径复算。")}</p></>}</div>;
}
