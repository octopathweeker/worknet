import React, { useEffect, useRef, useState } from 'react';
import { createPublicClient, createWalletClient, custom, http, parseUnits, formatUnits, encodeFunctionData, type Address, type Hex } from 'viem';
import { monadTestnet } from 'viem/chains';
import { requesterVaultAbi } from '@agent-task/contracts';
import { Brand, Icon, Money, short, relative } from './components';
import './platform.css';
import { BudgetPanel } from './BudgetPanel';
import { walletPaymentComplete, paymentMethod } from './budget-payment';
import { parseBudgetAmount } from './budget-amount';

type Goal = { id: string; input: { goal: string; kind: 'analysis' | 'research'; reward: string; sourceUrls?: string[] }; status: string; createdAt: string; taskId?: string; task?: any; result?: any; evidence?: any; verificationHistory?: any[]; events?: any[]; error?: string; audit?: { verdict: string; reason: string } };
type BudgetIntent = { id: string; amount: string };
type View = 'home' | 'deliveries' | 'budget';
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/platform/${path}`, { credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? '服务暂时不可用，请稍后重试。'); return data;
}
const reader = createPublicClient({ chain: monadTestnet, transport: http('https://testnet-rpc.monad.xyz'), pollingInterval: 1000 });
function status(goal: Goal) { if (goal.status === 'draft') return '待确认'; if (goal.status === 'completed') return '已交付'; if (goal.status === 'attention') return goal.audit?.verdict === 'reject' ? '复核未通过' : goal.task?.status === 3 ? '已结算，待核对' : '需要处理'; return ['等待接单', '执行中', '审核中', '已结算', '已取消', '已到期'][goal.task?.status] ?? '正在发布'; }
const txUrl = (hash: string) => `https://testnet.monadexplorer.com/tx/${hash}`;
const safeSource = (uri: unknown) => { try { const u = new URL(String(uri)); return u.protocol === 'https:' ? u.href : undefined; } catch { return undefined; } };

export default function PlatformApp() {
  const [config, setConfig] = useState<any>(); const [owner, setOwner] = useState<Address>(); const [account, setAccount] = useState<any>(); const [goals, setGoals] = useState<Goal[]>([]);
  const [view, setView] = useState<View>('home'); const [selected, setSelected] = useState<string>(); const [busy, setBusy] = useState(''); const [feedback, setFeedback] = useState(''); const [error, setError] = useState('');
  const [goal, setGoal] = useState(() => localStorage.getItem('worknet-goal-draft') ?? ''); const [kind, setKind] = useState<'analysis' | 'research'>('analysis'); const [sources, setSources] = useState('https://docs.monad.xyz/developer-essentials/eip-7702.md'); const [reward, setReward] = useState('0.05'); const [amount, setAmount] = useState('0.5'); const [fromBlock, setFromBlock] = useState(''); const [toBlock, setToBlock] = useState('');
  const planIntent = useRef<{ input: string; id: string } | undefined>(undefined); const [setup, setSetup] = useState<any>(); const [pendingSetup, setPendingSetup] = useState<BudgetIntent>(); const generation = useRef(0); const actionBusy = useRef(false); const [checkingBudget, setCheckingBudget] = useState(false); const [paymentProgress, setPaymentProgress] = useState('');
  useEffect(() => { localStorage.setItem('worknet-goal-draft', goal); }, [goal]);
  useEffect(() => { void Promise.all([api('config').then(setConfig), api('session').then(s => { if (s.authenticated) setOwner(s.address); })]).catch(e => setError(e.message)); }, []);
  useEffect(() => {
    const current = ++generation.current; setGoals([]); setAccount(undefined); setSetup(undefined); setPendingSetup(undefined); setAmount('0.5'); setSelected(undefined);
    setCheckingBudget(!!owner);
    if (!owner) return;
    const load = async () => { try { const [a, g, c] = await Promise.all([api('account'), api('goals'), api('config')]); if (generation.current === current) { setAccount(a); setGoals(g.goals); setConfig(c); } } catch (e) { if (generation.current === current) setError((e as Error).message); } };
    // A persisted intent must remain reachable after refresh or an account round-trip.
    // Restore its original amount and ID before offering any new budget operation.
    const restore = async () => {
      try {
        const saved = localStorage.getItem(`worknet-setup:${owner}`); if (!saved) return;
        const intent = JSON.parse(saved) as BudgetIntent;
        setPendingSetup(intent); setAmount(formatUnits(BigInt(intent.amount), 6));
        if (await budgetCompleted(intent)) {
          if (generation.current === current) { clearSetup(); setFeedback('上次充值已完成。'); }
          return;
        }
        const restored = await api('setup', intent);
        if (await budgetCompleted(intent, restored)) {
          if (generation.current === current) { clearSetup(); setFeedback('上次充值已完成。'); }
          return;
        }
        if (generation.current === current && localStorage.getItem(`worknet-setup:${owner}`) === saved) {
          setSetup(restored); setAmount(formatUnits(BigInt(intent.amount), 6));

        }
      } catch (e) { if (generation.current === current) setError(`上次充值未完成：${(e as Error).message}`); }
      finally { if (generation.current === current) setCheckingBudget(false); }
    };
    void restore();
    void load(); const timer = setInterval(() => void load(), 10000); return () => clearInterval(timer);
  }, [owner]);
  useEffect(() => {
    const provider = window.ethereum as any; if (!provider?.on) return;
    const change = (addresses: string[]) => { if (owner && addresses[0]?.toLowerCase() !== owner.toLowerCase()) { void api('logout', {}).catch(() => undefined); setOwner(undefined); setFeedback('钱包账户已改变，请重新签名登录。'); } };
    provider.on('accountsChanged', change); return () => provider.removeListener?.('accountsChanged', change);
  }, [owner]);
  async function action(name: string, fn: () => Promise<void>) { if (actionBusy.current) return; actionBusy.current = true; setBusy(name); setError(''); setFeedback(''); try { await fn(); } catch (e) { const detail = String((e as Error).message ?? e); setError(/rejected|denied|4001/i.test(detail) ? '你取消了钱包操作，可以保留当前内容稍后继续。' : detail.length > 350 ? '钱包或网络操作未完成。请检查钱包中的记录，再重试原操作。' : detail); } finally { actionBusy.current = false; setBusy(''); setPaymentProgress(''); } }
  async function wallet(expected?: Address) {
    if (!window.ethereum) throw new Error('请在已安装 EVM 钱包的浏览器中打开平台。');
    const client = createWalletClient({ chain: monadTestnet, transport: custom(window.ethereum) });
    const [address] = await client.requestAddresses(); if (!address) throw new Error('钱包未返回账户。');
    if (expected && expected.toLowerCase() !== address.toLowerCase()) throw new Error('当前钱包与登录账户不同，请切换回来或重新登录。');
    try { await client.switchChain({ id: 10143 }); } catch (e) { if ((e as any).code === 4902 || /not been added|Unrecognized chain/i.test(String(e))) { await client.addChain({ chain: monadTestnet }); await client.switchChain({ id: 10143 }); } else throw e; }
    return { client, address };
  }
  const connect = () => action('login', async () => { const { client, address } = await wallet(); const challenge = await api('auth/challenge', { address }); const signature = await client.signMessage({ account: address, message: challenge.message }); const result = await api('auth/verify', { id: challenge.id, signature }); setOwner(result.address); setFeedback('已登录。你的预算和任务独立保存。'); });
  async function refresh() { if (!owner) return; const [a, g] = await Promise.all([api('account'), api('goals')]); setAccount(a); setGoals(g.goals); }
  async function waitCommand(id: string) {
    for (let i = 0; i < 45; i++) { const result = await api(`commands/${id}`); if (result.status === 'complete') return result.result; if (result.status === 'failed') throw Object.assign(new Error(result.result?.error ?? '操作未完成。'), { confirmedFailure: true }); await new Promise(r => setTimeout(r, 2000)); }
    throw new Error('操作仍在后台处理中。你可以稍后刷新查看，不需要重新提交。');
  }
  const plan = () => action('plan', async () => {
    if (!owner) { await connect(); return; }
    const input = { goal, kind, reward: parseUnits(reward, 6).toString(), ...(kind === 'research' ? { sourceUrls: sources.split(/\s+/).filter(Boolean) } : { ...(fromBlock ? { fromBlock } : {}), ...(toBlock ? { toBlock } : {}) }) };
    const fingerprint = JSON.stringify(input); if (!planIntent.current || planIntent.current.input !== fingerprint) planIntent.current = { id: crypto.randomUUID(), input: fingerprint };
    const created = await api<Goal>('plans', { id: planIntent.current.id, ...input }); await refresh(); setSelected(created.id); setFeedback('计划已准备好。确认发布后才会托管任务奖励。');
  });
  const launch = (g: Goal) => action('launch', async () => { const key = `worknet-launch:${owner}:${g.id}`; const id = localStorage.getItem(key) ?? crypto.randomUUID(); localStorage.setItem(key, id); await api('launch', { id, goalId: g.id }); try { await waitCommand(id); } catch (e) { if ((e as any).confirmedFailure) localStorage.removeItem(key); throw e; } await refresh(); setFeedback('任务已发布，关闭页面后仍会继续执行。'); });
  async function budgetCommand(id: string) {
    const response = await fetch(`/platform/commands/${id}`, { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('暂时无法核对上次充值，请稍后重试。');
    return response.json();
  }
  async function budgetCompleted(intent: BudgetIntent, prepared?: any) {
    const command = await budgetCommand(intent.id);
    if (command) return command.status === 'complete';
    const journal = JSON.parse(localStorage.getItem(`worknet-wallet:${intent.id}`) ?? 'null');
    return walletPaymentComplete(journal, prepared?.calls?.length, hash => reader.getTransactionReceipt({ hash }).catch(() => undefined));
  }
  function clearSetup() { localStorage.removeItem(`worknet-setup:${owner}`); setSetup(undefined); setPendingSetup(undefined); setAmount('0.5'); }
  async function prepare() {
    if (!owner) throw new Error('请先连接钱包。');
    const savedKey = `worknet-setup:${owner}`; const prior = localStorage.getItem(savedKey);
    const intent = prior ? JSON.parse(prior) : { id: crypto.randomUUID(), amount: parseBudgetAmount(amount) };
    localStorage.setItem(savedKey, JSON.stringify(intent)); setPendingSetup(intent); setAmount(formatUnits(BigInt(intent.amount), 6));
    if (await budgetCompleted(intent)) { await finishSetup(); return; }
    const current = generation.current; const restored = await api('setup', intent);
    if (generation.current !== current) return;
    if (await budgetCompleted(intent, restored)) { await finishSetup(); return; }
    setSetup(restored); return restored;
  }
  const finishSetup = async () => { clearSetup(); setFeedback('充值已完成，可以发布任务了。'); try { await refresh(); } catch { setError('充值已完成，余额暂未同步，请稍后刷新。'); } };
  const discardSetup = () => action('discard', async () => {
    const intent = setup ?? pendingSetup; if (!intent) return;
    const journal = localStorage.getItem(`worknet-wallet:${intent.id}`);
    if (journal) {
      const recorded = JSON.parse(journal);
      if (recorded.complete) { await finishSetup(); return; }
      if (recorded.sending || recorded.batchId || recorded.steps?.some((step: any) => step?.sending || step?.hash)) throw new Error('已有钱包操作记录，请恢复原操作或先核对钱包交易，避免重复充值。');
      // Capability checks or an explicitly rejected wallet prompt have no submitted transaction.
    }
    const response = await fetch(`/platform/commands/${intent.id}`, { credentials: 'same-origin', cache: 'no-store' });
    if (response.ok) { const command = await response.json(); if (command.status === 'complete') { await finishSetup(); return; } if (command.status !== 'failed') throw new Error('原操作仍在处理，请等待确认。'); }
    else if (response.status !== 404) throw new Error('无法确认原操作状态，请稍后重试。');
    if (localStorage.getItem(`worknet-sponsor:${intent.id}`) && (!setup || Date.now() / 1000 < setup.validUntil)) throw new Error('已签署的授权仍有效，请恢复原操作，或等它到期后再准备新计划。');
    localStorage.removeItem(`worknet-setup:${owner}`); localStorage.removeItem(`worknet-sponsor:${intent.id}`); setSetup(undefined); setPendingSetup(undefined); setAmount('0.5'); setFeedback('已取消未执行的充值。');
  });
  async function fund(setup: any, mode: 'sponsor' | 'wallet') {
    if (!owner) return;
    setPaymentProgress('等待钱包确认…'); const { client, address } = await wallet(owner);
    if (mode === 'sponsor') {
      const existing = await fetch(`/platform/commands/${setup.id}`, { credentials: 'same-origin', cache: 'no-store' });
      if (existing.ok) { await waitCommand(setup.id); await finishSetup(); return; }
      if (existing.status !== 404) throw new Error('暂时无法确认原操作的状态，请稍后重试。');
      if (Date.now() / 1000 >= setup.validUntil) throw new Error('赞助授权计划已过期。确认没有已提交的操作后，请重新准备。');
      const key = `worknet-sponsor:${setup.id}`;
      const signature = localStorage.getItem(key) ?? await client.signTypedData({ account: address, ...setup.typedData });
      setPaymentProgress('正在确认充值…');
      localStorage.setItem(key, signature); await api('setup/sponsor', { id: setup.id, signature }); await waitCommand(setup.id);
    } else {
      const journalKey = `worknet-wallet:${setup.id}`; const journal = JSON.parse(localStorage.getItem(journalKey) ?? '{}');
      const provider = window.ethereum as any;
      if (!journal.mode) {
        let capabilities: any = {}; try { capabilities = await provider.request({ method: 'wallet_getCapabilities', params: [address] }); } catch { /* explicitly use ordinary transactions when batching is unavailable */ }
        const atomic = capabilities['0x279f']?.atomic?.status;
        journal.mode = atomic === 'supported' || atomic === 'ready' ? 'batch' : 'sequential'; localStorage.setItem(journalKey, JSON.stringify(journal));
      }
      if (journal.mode === 'batch') {
        if (journal.sending && !journal.batchId) { if (journal.requestId) journal.batchId = journal.requestId; else throw new Error('钱包尚未返回上一笔批量操作编号，请先检查钱包交易记录，避免重复充值。'); }
        if (!journal.batchId) {
          journal.sending = true; journal.requestId ??= '0x' + setup.id.replaceAll('-', ''); localStorage.setItem(journalKey, JSON.stringify(journal));
          try { const sent = await provider.request({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', id: journal.requestId, chainId: '0x279f', from: address, atomicRequired: true, calls: setup.calls.map((c: any) => ({ to: c.target, data: c.callData, value: '0x0' })) }] }); journal.batchId = typeof sent === 'string' ? sent : sent.id; if (!journal.batchId) throw new Error('钱包未返回批量操作编号。'); journal.sending = false; localStorage.setItem(journalKey, JSON.stringify(journal)); }
          catch (e) { if ((e as any).code === 4001) { journal.sending = false; localStorage.setItem(journalKey, JSON.stringify(journal)); } throw e; }
        }
        let complete = false;
        for (let i = 0; i < 60; i++) { const state = await provider.request({ method: 'wallet_getCallsStatus', params: [journal.batchId] }); if (state.status === 200 || state.status === 'CONFIRMED') { if (state.receipts?.some((r: any) => r.status === '0x0')) throw new Error('批量交易执行失败，请检查钱包记录。'); complete = true; break; } if (Number(state.status) >= 400) throw new Error('批量交易未成功，请查看钱包记录。'); await new Promise(r => setTimeout(r, 2000)); }
        if (!complete) throw new Error('批量交易仍待确认，稍后点击同一按钮会查询原操作。');
      } else {
        journal.steps ??= [];
        for (let i = 0; i < setup.calls.length; i++) {
          const entry = journal.steps[i] ?? {}; if (entry.sending && !entry.hash) throw new Error('钱包尚未返回上一笔交易 hash，请检查钱包记录，避免重复充值。');
          if (!entry.hash) { entry.sending = true; journal.steps[i] = entry; localStorage.setItem(journalKey, JSON.stringify(journal)); const c = setup.calls[i];
            try { entry.hash = await client.sendTransaction({ account: address, to: c.target, data: c.callData, value: 0n }); entry.sending = false; localStorage.setItem(journalKey, JSON.stringify(journal)); }
            catch (e) { if ((e as any).code === 4001 || /User rejected/i.test(String(e))) { entry.sending = false; localStorage.setItem(journalKey, JSON.stringify(journal)); } throw e; }
          }
          setPaymentProgress(`确认中 ${i + 1}/${setup.calls.length}…`);
          const receipt = await reader.waitForTransactionReceipt({ hash: entry.hash, timeout: 60000 }); if (receipt.status !== 'success') throw new Error('钱包交易执行失败，请检查交易记录。');
        }
      }
      journal.complete = true; localStorage.setItem(journalKey, JSON.stringify(journal));
    }
    await finishSetup();
  }
  const recharge = (preferWallet = false) => action('fund', async () => {
    if (checkingBudget) return;
    setPaymentProgress('正在准备充值…');
    const prepared = await prepare(); if (!prepared) return;
    const command = await budgetCommand(prepared.id);
    if (command?.status === 'complete') { await finishSetup(); return; }
    const mode = paymentMethod(!!command, !!localStorage.getItem(`worknet-sponsor:${prepared.id}`), !!localStorage.getItem(`worknet-wallet:${prepared.id}`), account?.accountMode === 'metamask-7702', preferWallet);
    await fund(prepared, mode);
  });
  const ownerCall = (fn: 'revokeAgent' | 'withdraw' | 'cancelTask' | 'acceptResult' | 'rejectResult', g?: Goal) => action(fn, async () => {
    if (!owner || !account?.vault) return; const { client, address } = await wallet(owner);
    let args: any[] = [config.operator];
    if (fn === 'withdraw') args = [BigInt(account.budget?.vaultBalance ?? '0'), address];
    if (fn === 'cancelTask') args = [BigInt(g!.taskId!)];
    if (fn === 'acceptResult') args = [BigInt(g!.taskId!), BigInt(g!.task.attempt), g!.task.resultHash];
    if (fn === 'rejectResult') { const reason = window.prompt('请输入拒绝当前交付的原因'); if (!reason?.trim()) return; const { keccak256, stringToHex } = await import('viem'); args = [BigInt(g!.taskId!), BigInt(g!.task.attempt), g!.task.resultHash, keccak256(stringToHex(reason))]; }
    const data = encodeFunctionData({ abi: requesterVaultAbi, functionName: fn, args } as any);
    const hash = await client.sendTransaction({ account: address, to: account.vault, data }); const receipt = await reader.waitForTransactionReceipt({ hash }); if (receipt.status !== 'success') throw new Error('链上操作未成功。'); await refresh(); setFeedback('钱包操作已确认，平台将同步最新任务状态。');
  });
  const current = goals.find(g => g.id === selected); const online = config?.health && Date.now() - config.health.updatedAt < 120000 && config.health.ready;
  const navigate = (next: View) => { setView(next); setSelected(undefined); setError(''); };
  return <div className="workspace-shell platform-shell">
    <aside className="rail"><a href="/" aria-label="Worknet 首页"><Brand/></a><div className="platform-identity"><span className="identity-mark"><Icon name="wallet"/></span><div><strong>{owner ? short(owner) : '你的独立账户'}</strong><small>{owner ? '个人账户' : '连接钱包开始'}</small></div></div><button className="button primary new-goal" onClick={() => navigate('home')}><Icon name="plus" size={17}/>发布新任务</button><nav aria-label="主导航">{([['home','goal','我的任务'],['deliveries','file','交付文档'],['budget','wallet','预算与账户']] as const).map(([id,icon,label]) => <button key={id} className={view === id ? 'active' : ''} onClick={() => navigate(id)}><Icon name={icon}/>{label}</button>)}</nav><div className="rail-bottom"><div className="connection-card"><span className={`status-dot ${online ? 'online' : ''}`}/><div>{online ? '平台执行服务在线' : '正在检查服务'}<small>关闭页面后任务仍可继续</small></div></div><a className="resources-link" href="/#legacy" onClick={() => setTimeout(() => location.reload(), 0)}>原团队工作区<Icon name="link" size={14}/></a></div></aside>
    <main className="workspace-main"><header className="topbar"><span className="breadcrumb">Worknet / {view === 'budget' ? '预算与账户' : view === 'deliveries' ? '交付文档' : '我的任务'}</span><span className="mobile-brand"><Brand/></span><div className="top-actions"><span className="testnet-label">Monad Testnet</span>{owner ? <button className="button subtle" onClick={() => void action('logout', async () => { await api('logout', {}); setOwner(undefined); })} disabled={!!busy}>{short(owner)}<Icon name="logout" size={15}/></button> : <button className="button primary" onClick={() => void connect()} disabled={!!busy}>{busy === 'login' ? '等待钱包签名…' : '连接钱包'}</button>}</div></header>
    <div className="page-body"><div aria-live="polite">{feedback && <div className="feedback success"><Icon name="check" size={18}/>{feedback}</div>}</div>{error && <div className="feedback error" role="alert"><Icon name="warning" size={18}/><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="关闭提示"><Icon name="close" size={16}/></button></div>}
    {current ? <><button className="back-button" onClick={() => setSelected(undefined)}>返回我的任务</button><div className="detail-heading"><span className={`pill ${current.status}`}>{status(current)}</span><h1>{current.input.goal}</h1><p>任务奖励 <Money amount={current.input.reward}/> test USDC</p></div>
      {current.status === 'draft' ? <div className="plan-layout"><article className="plan-paper"><h2>这次任务的交付约定</h2><div className="platform-brief"><Icon name={current.input.kind === 'research' ? 'spark' : 'grid'} size={32}/><div><h3>{current.input.kind === 'research' ? '有来源引用的研究简报' : '可独立复算的转账分析'}</h3><p>{current.input.kind === 'research' ? '阅读指定资料，形成回答目标的简报；重新抓取来源并由独立 Judge 审核。' : '完整查询指定区间的测试 USDC Transfer，交付次数与原始金额，并独立复算。'}</p></div></div>{current.input.sourceUrls?.map(uri => <p key={uri}><a href={safeSource(uri)} target="_blank" rel="noreferrer">{uri}</a></p>)}<p>任务与交付公开保存。执行期限 1 小时，提交后审核窗口 10 分钟。审核超时可能付款，不等于验证通过。</p></article><aside className="plan-confirm"><Icon name="wallet" size={26}/><h2>确认并发布</h2><div className="plan-price"><Money amount={current.input.reward}/><span>test USDC</span></div><p>奖励将从你的独立预算托管到任务合约。</p><button className="button primary full-width" disabled={!!busy || !account?.budget?.effectiveActive} onClick={() => void launch(current)}>{busy === 'launch' ? '正在发布…' : '确认并发布'}</button>{!account?.budget?.effectiveActive && <button className="text-button full-width" onClick={() => navigate('budget')}>先准备任务预算</button>}</aside></div> : <>
      <div className="execution-progress">{['等待接单','执行','审核','交付'].map((label,i) => <div key={label} className={Number(current.task?.status ?? -1) >= i ? 'done' : ''}><span>{i + 1}</span><b>{label}</b></div>)}</div>{current.error && <p className="document-warning">{current.error}</p>}
      {current.result ? <article className="deliverable"><div className="deliverable-head"><Icon name="file"/><h2>任务交付</h2><span className={`pill ${current.evidence?.verdict === 'accept' && current.audit?.verdict !== 'reject' ? 'completed' : 'attention'}`}>{current.audit?.verdict === 'reject' ? '复核未通过' : current.evidence?.verdict === 'accept' ? '独立检查通过' : '尚未通过检查'}</span></div><div className="result-document">{current.input.kind === 'analysis' ? <div className="analysis-result"><div><span>转账次数</span><strong>{current.result.output.eventCount}</strong></div><div><span>转账总额</span><strong><Money amount={current.result.output.totalAmountBaseUnits}/><small>test USDC</small></strong></div></div> : <><p className="research-summary">{current.result.output.summary}</p>{current.result.output.findings?.map((f: any,i: number) => <section className="finding" key={i}><h3>{f.title}</h3><p>{f.claim}</p><blockquote>{f.quote}</blockquote><a href={safeSource(f.sourceUri)} target="_blank" rel="noreferrer">查看来源</a></section>)}</>}</div></article> : <div className="empty-state"><Icon name="clock" size={30}/><h3>任务正在平台上推进</h3><p>你可以离开页面，稍后回到这里阅读交付。</p></div>}
      {current.task?.status === 0 && <button className="button subtle" disabled={!!busy} onClick={() => void ownerCall('cancelTask', current)}>用钱包取消未领取任务</button>}
      {current.task?.status === 2 && <div className="platform-owner-review"><h3>Owner 手动接管</h3><p>当前提交的审核截止时间：{new Date(Number(current.task.reviewDeadline) * 1000).toLocaleString()}。人工接受将付款给当前提交者。</p><button className="button subtle" disabled={!!busy} onClick={() => void ownerCall('acceptResult', current)}>接受当前交付并付款</button><button className="text-button danger" disabled={!!busy} onClick={() => void ownerCall('rejectResult', current)}>拒绝当前交付</button></div>}
      <details className="technical"><summary>执行与验证记录</summary><dl><dt>任务</dt><dd>#{current.taskId} / attempt {current.task?.attempt}</dd><dt>领取地址</dt><dd>{current.task?.worker}</dd><dt>Result hash</dt><dd>{current.task?.resultHash}</dd></dl>{(current.verificationHistory?.length ? current.verificationHistory : current.evidence ? [current.evidence] : []).map((e: any,j: number) => <section key={j}><h3>第 {e.attempt} 轮：{e.verdict === 'accept' ? '自动审核接受' : '自动审核拒绝'}</h3>{e.checks?.map((c: any,i: number) => <p key={i}>{c.passed ? '通过' : '未通过'}：{c.detail}</p>)}</section>)}{current.events?.map((e,i) => <p key={i}>{e.event} <a href={txUrl(e.transactionHash)} target="_blank" rel="noreferrer">查看交易</a></p>)}</details></>}
    </> : view === 'home' ? <><div className="home-heading"><span className="heading-symbol"><Icon name="goal" size={30}/></span><h1>让目标，成为交付。</h1><p>用自己的预算发布任务。Agent 执行，结果独立检查，奖励按约定结算。</p></div>{!owner && <div className="platform-welcome"><div><h2>从你的钱包开始</h2><p>登录签名仅用于确认身份。发布前，你会看到工作内容、奖励和验收方式。</p></div><button className="button primary" disabled={!!busy} onClick={() => void connect()}>连接钱包并登录</button></div>}
      <form className="goal-composer" onSubmit={e => { e.preventDefault(); if (owner) void plan(); else void connect(); }}><label className="composer-label" htmlFor="platform-goal">你希望得到什么结果？</label><textarea id="platform-goal" value={goal} onChange={e => setGoal(e.target.value)} minLength={8} maxLength={2000} required placeholder="例如：分析最近 100 个确认区块中的 USDC 转账，给我一份可复核的数据报告。"/><div className="composer-options"><div className="kind-selector"><button type="button" className={kind === 'analysis' ? 'selected' : ''} onClick={() => setKind('analysis')}><Icon name="grid" size={16}/>链上分析</button><button type="button" className={kind === 'research' ? 'selected' : ''} onClick={() => setKind('research')} disabled={config && !config.modelAvailable}><Icon name="spark" size={16}/>资料研究</button></div></div><details className="source-settings"><summary>资料范围与奖励</summary><div className="platform-fields">{kind === 'research' ? <label>资料地址（每行一条，当前支持 Monad 官方文档）<textarea value={sources} onChange={e => setSources(e.target.value)}/></label> : <div className="field-pair"><label>起始区块（留空使用最近区间）<input value={fromBlock} onChange={e => setFromBlock(e.target.value)} inputMode="numeric"/></label><label>结束区块<input value={toBlock} onChange={e => setToBlock(e.target.value)} inputMode="numeric"/></label></div>}<label>任务奖励（0.01–0.20 test USDC）<input value={reward} onChange={e => setReward(e.target.value)} inputMode="decimal"/></label></div></details><div className="composer-footer"><span><Icon name="check" size={15}/>先审阅计划，确认后再发布</span><button className="button primary" disabled={!!busy || goal.trim().length < 8}>{busy === 'plan' ? '正在准备…' : owner ? '生成任务计划' : '登录并继续'}<Icon name="arrow" size={17}/></button></div></form>
      <section className="recent-section"><div className="section-heading"><h2>我的任务</h2><span>仅显示当前账户的目标</span></div><GoalRows goals={goals} onOpen={setSelected}/></section>
    </> : view === 'deliveries' ? <><div className="page-heading"><h1>交付文档</h1><p>任务成果、来源和检查记录，都保存在这里。</p></div><GoalRows goals={goals.filter(g => g.result)} onOpen={setSelected}/></> : <><div className="page-heading budget-page-heading"><h1>任务预算</h1><p>充值后，用于支付你发布的任务。</p></div>{!owner ? <button className="button primary" disabled={!!busy} onClick={() => void connect()}>连接钱包</button> : <BudgetPanel account={account} owner={owner} operator={config?.operator} amount={amount} pending={pendingSetup} busy={!!busy} checking={checkingBudget} progress={paymentProgress} hasActiveTasks={goals.some(g => g.taskId && Number(g.task?.status ?? 0) < 3)} setAmount={setAmount} recharge={preferWallet => void recharge(preferWallet)} cancel={() => void discardSetup()} withdraw={() => void ownerCall('withdraw')} revoke={() => void ownerCall('revokeAgent')}/>}
    </>}
    <footer className="workspace-footer"><span>任务内容与交付公开保存，请使用公开资料。</span><span>Worknet · Monad Testnet</span></footer></div></main></div>;
}
function GoalRows({ goals, onOpen }: { goals: Goal[]; onOpen(id: string): void }) { return <div className="goal-list">{goals.map(g => <button key={g.id} className="goal-row" onClick={() => onOpen(g.id)}><span className={`goal-row-icon ${g.status}`}><Icon name={g.status === 'completed' ? 'check' : g.status === 'draft' ? 'file' : 'clock'}/></span><span className="goal-row-copy"><strong>{g.input.goal}</strong><small>{g.input.kind === 'research' ? '资料研究' : '链上分析'} · {relative(g.createdAt)} · <Money amount={g.input.reward}/> test USDC</small></span><span className={`pill ${g.status}`}>{status(g)}</span><Icon name="chevron"/></button>)}{!goals.length && <div className="empty-inline"><Icon name="file"/><span>这里还没有任务。先描述希望获得的结果。</span></div>}</div>; }
