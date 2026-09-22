import { TaskProgress, type ProgressUpdate } from './TaskProgress';
import { GeneralDelivery } from './GeneralDelivery';
import {pendingAgentId} from './AgentOnboarding';
import { AccountSetup, BudgetReminder } from './AccountSetup';
import { PlatformFooter } from './PlatformFooter';
import { ProtocolEvidence } from './ProtocolEvidence';
import { MeraLogin } from './MeraLogin';
import { PrivateDelivery } from './PrivateDelivery';
import { enterMera, meraWallet, lockMera, createPrivateDelivery, meraFailureMessage } from './mera-account';
import { isPrivateOutput, type DeliveryConfig } from '@agent-task/privacy';
import { QuorumPanel, QuorumTerms } from './QuorumPanel';
import { useToast } from './Toast';
import {LanguageSwitcher} from './LanguageSwitcher';
import {t as tr,locale} from './i18n';
import {ActivityPanel} from './ActivityPanel';
import {MarketRules,RecoveryHint} from './MarketGuidance';
import { visiblePolling } from './polling';
import React, { useEffect, useRef, useState } from 'react';
import { createPublicClient, createWalletClient, custom, http, parseUnits, formatUnits, encodeFunctionData, type Address, type Hex } from 'viem';
import { monadTestnet } from 'viem/chains';
import { requesterVaultAbi } from '@agent-task/contracts';
import { Brand, Icon, Money, short, relative } from './components';
import './platform.css';
import { settlementMoney } from './settlement';
import { TaskComposer } from './TaskComposer';
import { TakerPanel } from './TakerPanel';
import { BudgetPanel } from './BudgetPanel';
import { walletPaymentState, paymentMethod } from './budget-payment';
import { walletSendFailure } from './wallet-send';
import { confirmPublication, expiredBudgetPermission } from './publication-flow';
import { parseBudgetAmount } from './budget-amount';
import { taskBudgetIssue, publicationBudgetIssue, renewalAmount } from './budget-status';
import { taskReward, draftParameters, type Agreement, type TaskDraft } from './platform-draft';
import { platformHash, readPlatformHash, usePlatformRoute } from './hash-route';

type Goal = { progress?: ProgressUpdate[]; spec?: { delivery?: DeliveryConfig; verification?: { criteria: string[] } }; toolPayments?: any[]; settlement?: any; id: string; input: { goal: string; kind: 'analysis' | 'research' | 'general'; reward: string; sourceUrls?: string[]; fromBlock?: string; toBlock?: string; agreement?: Agreement; execution?: 'market' | 'platform' }; status: string; createdAt: string; taskId?: string; task?: any; result?: any; evidence?: any; verificationHistory?: any[]; events?: any[]; error?: string; publication?: { id: string; status: string; error?: string }; audit?: { verdict: string; reason: string } };
type BudgetIntent = { id: string; amount: string; mode?: 'recharge' | 'authorize' };
type View = 'home' | 'deliveries' | 'budget' | 'taker';
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/platform/${path}`, { credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? '服务暂时不可用，请稍后重试。'); return data;
}
const legacyWalletMode = new URLSearchParams(location.search).get('account') === 'external';
const reader = createPublicClient({ chain: monadTestnet, transport: http('https://testnet-rpc.monad.xyz'), pollingInterval: 1000 });
function status(goal: Goal) { if (!goal.taskId && ['queued', 'processing'].includes(goal.publication?.status ?? '')) return '等待发布'; if (!goal.taskId && goal.publication?.status === 'failed') return '发布未完成'; if (goal.task?.status === 4) return '已取消'; if (goal.task?.status === 5) return '已到期'; if (goal.status === 'draft') return '待确认'; if (goal.settlement && goal.settlement.completionBps < 10000) return '已按完成度结算'; if (goal.status === 'completed') return '已交付'; if (goal.status === 'attention') return goal.audit?.verdict === 'reject' ? '复核未通过' : goal.task?.status === 3 ? '已结算，待核对' : '需要处理'; return ['等待接单', '执行中', '审核中', '已结算', '已取消', '已到期'][goal.task?.status] ?? '正在发布'; }
const txUrl = (hash: string) => `https://testnet.monadexplorer.com/tx/${hash}`;
const safeSource = (uri: unknown) => { try { const u = new URL(String(uri)); return u.protocol === 'https:' ? u.href : undefined; } catch { return undefined; } };

export default function PlatformApp() {
  const [loginOpen,setLoginOpen]=useState(false);const [loginError,setLoginError]=useState('');const [privateDelivery,setPrivateDelivery]=useState(true);
  const [config, setConfig] = useState<any>(); const [owner, setOwner] = useState<Address>(); const [account, setAccount] = useState<any>(); const [goals, setGoals] = useState<Goal[]>([]);
  const [view, setView] = useState<View>(() => readPlatformHash().view); const [selected, setSelected] = useState<string | undefined>(() => readPlatformHash().goal); const [busy, setBusy] = useState(''); const toast = useToast(); const [syncError, setSyncError] = useState('');
  const route = usePlatformRoute();
  useEffect(() => {
    setSelected(previous => (previous === route.goal ? previous : route.goal));
    if (route.view !== view) { if (route.view !== 'taker') void refresh().catch(e => toast.error((e as Error).message)); setView(route.view); }
  }, [route]);
  const [runTarget,setRunTarget]=useState<{id:string;seq:number}>();
  const [editingDraft, setEditingDraft] = useState<TaskDraft>(); const [composerKey, setComposerKey] = useState(0);
  const [amount, setAmount] = useState('0.5');
  const planIntent = useRef<{ input: string; id: string } | undefined>(undefined); const [setup, setSetup] = useState<any>(); const [pendingSetup, setPendingSetup] = useState<BudgetIntent>(); const generation = useRef(0); const actionBusy = useRef(false); const [checkingBudget, setCheckingBudget] = useState(false); const [paymentProgress, setPaymentProgress] = useState('');

  useEffect(() => { void Promise.all([api('config').then(setConfig), api('session').then(s => { if (s.authenticated) setOwner(s.address); })]).catch(e => setSyncError(e.message)); }, []);
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const viewRef=useRef(view); viewRef.current=view;
  const goalsRef=useRef(goals); goalsRef.current=goals;
  useEffect(() => {
    const current = ++generation.current; setGoals([]); setAccount(undefined); setSetup(undefined); setPendingSetup(undefined); setAmount('0.5'); setSelected(readPlatformHash().goal);setRunTarget(undefined);
    setCheckingBudget(!!owner); setSyncError('');
    if (!owner) return;
    let lastAccount=0,lastGoals=0,lastConfig=0;
    const load = async () => {
      const now=Date.now();const active=goalsRef.current.some(g=>['queued','running'].includes(g.status));
      const jobs:Promise<void>[]=[];
      if(now-lastAccount>(viewRef.current==='budget'||goalsRef.current.some(g=>!g.taskId)?15000:120000))jobs.push(api('account').then(a=>{if(generation.current===current){setAccount(a);lastAccount=Date.now();}}));
      if(viewRef.current!=='taker'&&now-lastGoals>(active?10000:60000))jobs.push(api('goals').then(g=>{if(generation.current===current){setGoals(g.goals);lastGoals=Date.now();}}));
      if(now-lastConfig>120000)jobs.push(api('config').then(c=>{if(generation.current===current){setConfig(c);lastConfig=Date.now();}}));
      await Promise.all(jobs); if (jobs.length && generation.current === current) setSyncError('');
    };
    // A persisted intent must remain reachable after refresh or an account round-trip.
    // Restore its original amount and ID before offering any new budget operation.
    const restore = async () => {
      try {
        const saved = localStorage.getItem(`worknet-setup:${owner}`); if (!saved) return;
        const intent = JSON.parse(saved) as BudgetIntent;
        setPendingSetup(intent); setAmount(formatUnits(BigInt(intent.amount), 6));
        if (await budgetCompleted(intent)) {
          if (generation.current === current) { clearSetup(intent.id); toast.success('上次预算操作已完成。'); }
          return;
        }
        const restored = await api('setup', intent);
        if (await budgetCompleted(intent, restored)) {
          if (generation.current === current) { clearSetup(intent.id); toast.success('上次预算操作已完成。'); }
          return;
        }
        if (generation.current === current && localStorage.getItem(`worknet-setup:${owner}`) === saved) {
          setSetup(restored); setAmount(formatUnits(BigInt(intent.amount), 6));

        }
      } catch (e) { if (generation.current === current) toast.error(`上次预算操作未完成：${(e as Error).message}`); }
      finally { if (generation.current === current) setCheckingBudget(false); }
    };
    void restore();
    return visiblePolling(load,()=>10000,e=>{if(generation.current===current)setSyncError((e as Error).message);});
  }, [owner]);
  async function action(name: string, fn: () => Promise<void>) { if (actionBusy.current) return; actionBusy.current = true; setBusy(name); toast.clear(); try { await fn(); } catch (e) { const detail = meraFailureMessage(e); if (walletSendFailure(e) === 'insufficient-funds') toast.error('钱包 test MON 不足以支付手续费，请补充后继续原任务，无需再次充值 USDC。'); else if (/rejected|denied|4001/i.test(detail) || walletSendFailure(e) === 'rejected') toast.info('你取消了钱包操作，可以保留当前内容稍后继续。'); else toast.error(detail.length > 350 ? '钱包或网络操作未完成。请检查钱包中的记录，再重试原操作。' : detail); } finally { actionBusy.current = false; setBusy(''); setPaymentProgress(''); } }
  async function wallet(expected?: Address) {
    if (!legacyWalletMode) return meraWallet(expected);
    if (!window.ethereum) throw new Error('旧账户入口需要原来的浏览器钱包。');
    const client=createWalletClient({chain:monadTestnet,transport:custom(window.ethereum)});
    const [address]=await client.requestAddresses();
    if(!address||expected&&expected.toLowerCase()!==address.toLowerCase())throw new Error('当前钱包与登录账户不同，请切换回来或重新登录。');
    try {await client.switchChain({id:10143});} catch(error) {if((error as any).code===4902){await client.addChain({chain:monadTestnet});await client.switchChain({id:10143});}else throw error;}
    return {client,address};
  }
  const connect = () => { if(legacyWalletMode){void action('login',async()=>{const {client,address}=await wallet();const challenge=await api('auth/challenge',{address});const signature=await client.signMessage({account:address,message:challenge.message});const result=await api('auth/verify',{id:challenge.id,signature});setOwner(result.address);});return;} setLoginError(''); setLoginOpen(true); };
  async function loginMera(mode: 'create' | 'signin') {
    await action('login',async()=>{
      try {
        const account = await enterMera(mode);
        const challenge = await api('auth/challenge',{address:account.address});
        const signature = await account.signMessage({message:challenge.message});
        const result = await api('auth/verify',{id:challenge.id,signature});
        setOwner(result.address);setLoginOpen(false);
        if(mode === 'create'&&pendingAgentId()){toast.success('Agent 账户已创建，请继续确认执行权限。');}
        else if(mode === 'create') { location.hash = platformHash({view:'budget'}); toast.success('账户已创建。接下来领取测试币并准备任务预算。'); }
        else toast.success('已登录。你的预算和任务独立保存。');
      } catch(error) { lockMera(); setLoginError(/PRF|UNSUPPORTED/.test(String(error)) ? '当前设备未提供 PRF。请使用支持的通行密钥提供商，或换设备重试。' : '未完成通行密钥登录。请重试；恢复账户时请选择原来的通行密钥。'); }
    });
  }
  async function refresh() { if (!owner) return; const [a, g] = await Promise.all([api('account'), api('goals')]); setAccount(a); setGoals(g.goals); }
  async function waitCommand(id: string) {
    let lastRetryNotice = '';
    for (let i = 0; i < 45; i++) { const result = await api(`commands/${id}`); if (result.status === 'complete') return result.result; if (result.result?.retrying && result.result?.error && result.result.error !== lastRetryNotice) { lastRetryNotice = result.result.error; toast.info(`${result.result.error} 原请求已保留，后台会继续处理。`); } if (result.status === 'failed') throw Object.assign(new Error(result.result?.error ?? '操作未完成。'), { confirmedFailure: true }); await new Promise(r => setTimeout(r, 2000)); }
    throw new Error('操作仍在后台处理中。你可以稍后刷新查看，不需要重新提交。');
  }
  const plan = (draft: TaskDraft) => action('plan', async () => {
    if (!owner) { await connect(); return; }
    const { goal, kind, reward, agreement } = draft;
    const { sourceUrls, ...range } = draftParameters(draft);
    if (!agreement) throw new Error('请先拟定交付与验收。');
    const input = { goal, kind, execution: 'market', agreement, reward: taskReward(reward), ...range, ...(sourceUrls.length ? { sourceUrls } : {}) };
    const fingerprint = JSON.stringify({ ...input, owner, privateDelivery: privateDelivery && !legacyWalletMode && !!config?.privacy?.reviewPublicKey }); if (!planIntent.current || planIntent.current.input !== fingerprint) planIntent.current = { id: crypto.randomUUID(), input: fingerprint };
    const delivery = privateDelivery && !legacyWalletMode && config?.privacy?.reviewPublicKey ? await createPrivateDelivery(owner,planIntent.current.id,config.privacy.reviewPublicKey) : undefined;
    const created = await api<Goal>('plans', { id: planIntent.current.id, ...input, ...(delivery ? {delivery} : {}) }); await refresh(); setEditingDraft(undefined); location.hash = platformHash({ goal: created.id }); toast.success('计划已准备好。确认发布后才会托管任务奖励。');
  });
  function assertSession(expectedOwner: Address | undefined, expectedGeneration: number) {
    if (!expectedOwner || ownerRef.current !== expectedOwner || generation.current !== expectedGeneration) throw new Error('登录账户已改变，原任务已保留，请重新打开后继续。');
  }
  const launch = (g: Goal) => action('launch', async () => {
    const sessionGeneration = generation.current;
    const check = () => assertSession(owner, sessionGeneration);
    const key = `worknet-launch:${owner}:${g.id}`;
    await confirmPublication({
      reward: g.input.reward, assertCurrent: check,
      recover: async () => {
        const latest = await api('goals'); check(); setGoals(latest.goals);
        const existing = latest.goals.find((item: Goal) => item.id === g.id);
        if (existing?.taskId) return true;
        const saved = localStorage.getItem(key);
        const id = existing?.publication?.id ?? saved;
        if (!id) return false;
        const command = await budgetCommand(id); check();
        if (!command) return false;
        if (command.status === 'failed') { if (saved === id) localStorage.removeItem(key); return false; }
        localStorage.setItem(key, id);
        try { await waitCommand(id); } catch (e) { if ((e as any).confirmedFailure && localStorage.getItem(key) === id) localStorage.removeItem(key); throw e; }
        check(); await refresh(); return true;
      },
      readAccount: async () => { const fresh = await api('account'); check(); setAccount(fresh); return fresh; },
      preparePayment: async () => {
        setPaymentProgress('正在准备发布，请按钱包提示确认…');
        for (let i = 0; i < 2; i++) {
          const prepared = await prepare('authorize', true); check();
          if (!prepared) continue; // A completed stale intent was cleared; prepare the current permission.
          const command = await budgetCommand(prepared.id); check();
          const mode = paymentMethod(!!command, !!localStorage.getItem(`worknet-sponsor:${prepared.id}`));
          await fund(prepared, mode, true); check(); return;
        }
      },
      wait: async () => { setPaymentProgress('正在同步钱包确认，完成后自动发布…'); await new Promise(resolve => setTimeout(resolve, 1000)); },
      publish: async () => {
        check(); setPaymentProgress('正在确认发布…');
        const id = localStorage.getItem(key) ?? crypto.randomUUID(); localStorage.setItem(key, id);
        await api('launch', { id, goalId: g.id }); check();
        try { await waitCommand(id); } catch (e) { if ((e as any).confirmedFailure && localStorage.getItem(key) === id) localStorage.removeItem(key); await refresh(); throw e; }
        check(); await refresh();
      },
    });
    check(); toast.success('任务已发布，关闭页面后仍会继续执行。');
  });
  async function budgetCommand(id: string) {
    const response = await fetch(`/platform/commands/${id}`, { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('暂时无法核对上次预算操作，请稍后重试。');
    return response.json();
  }
  async function budgetCompleted(intent: BudgetIntent, prepared?: any) {
    const command = await budgetCommand(intent.id);
    if (command?.status === 'complete') return true;
    if (prepared?.mode === 'authorize' && await authorizationObserved(prepared)) return true;
    if (command) return false;
    return await reconcileWalletPayment(intent.id, prepared?.calls?.length) === 'complete';
  }
  async function reconcileWalletPayment(id: string, callCount?: number) {
    const key = `worknet-wallet:${id}`;
    const journal = JSON.parse(localStorage.getItem(key) ?? 'null');
    const state = await walletPaymentState(journal, callCount ?? journal?.callCount,
      hash => reader.getTransactionReceipt({ hash }).catch(() => undefined),
      async batchId => {
        if (journal.batchStatus && (Number(journal.batchStatus.status) >= 200 && Number(journal.batchStatus.status) < 300 || Number(journal.batchStatus.status) >= 400 && Number(journal.batchStatus.status) < 700 || journal.batchStatus.status === 'CONFIRMED')) return journal.batchStatus;
        const result = await (window.ethereum as any)?.request({ method: 'wallet_getCallsStatus', params: [batchId] });
        if (result) { journal.batchStatus = { status: result.status, chainId: result.chainId, receipts: result.receipts?.map((r: any) => ({ status: r.status, transactionHash: r.transactionHash })) }; localStorage.setItem(key, JSON.stringify(journal)); }
        return result;
      });
    if (state === 'complete') { journal.complete = true; journal.sending = false; localStorage.setItem(key, JSON.stringify(journal)); }
    return state;
  }
  async function authorizationObserved(prepared: any) {
    if (prepared.mode !== 'authorize') return false;
    const fresh = await api('account');
    const budget = fresh.budget;
    return !!budget?.effectiveActive && String(budget.validUntil) === String(prepared.authorizationUntil)
      && String(budget.maxTotalCommitment) === prepared.amount
      && BigInt(budget.maxPerTask) === (BigInt(prepared.amount) < 200000n ? BigInt(prepared.amount) : 200000n);
  }
  async function waitForAuthorization(prepared: any) {
    for (let i = 0; i < 15; i++) {
      if (await authorizationObserved(prepared)) return true;
      setPaymentProgress('正在同步钱包确认，完成后自动发布…');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
  }
  function clearSetup(expectedId?: string) {
    const key = `worknet-setup:${owner}`;
    if (expectedId && JSON.parse(localStorage.getItem(key) ?? 'null')?.id !== expectedId) return;
    localStorage.removeItem(key); setSetup(undefined); setPendingSetup(undefined); setAmount('0.5');
  }
  async function retirePreviousSetup(intent: BudgetIntent) {
    const sessionGeneration = generation.current;
    setPaymentProgress('正在核对上次预算操作…');
    const [prepared, fresh] = await Promise.all([api('setup', intent), api('account')]);
    assertSession(owner, sessionGeneration);
    if (expiredBudgetPermission(prepared, fresh.chainTimestamp)) {
      // Its final authorization now reverts even if an old wallet request arrives late.
      // Preserve unknown deposits as unknown; never query or replay them to publish a funded task.
      localStorage.setItem(`worknet-retired:${intent.id}`, JSON.stringify({ reason: 'authorization-expired', chainTimestamp: fresh.chainTimestamp }));
      clearSetup(intent.id); return;
    }
    let command = await budgetCommand(intent.id);
    if (command && !['complete', 'failed'].includes(command.status)) { await waitCommand(intent.id); command = await budgetCommand(intent.id); }
    if (command?.status !== 'complete') {
      let state = await reconcileWalletPayment(intent.id);
      for (let i = 0; state === 'pending' && i < 20; i++) {
        setPaymentProgress('正在等待钱包确认，完成后自动继续发布…');
        await new Promise(resolve => setTimeout(resolve, 1000)); state = await reconcileWalletPayment(intent.id);
      }
      if (state === 'pending') throw new Error('钱包交易仍在确认中，原任务已保留，稍后点击确认发布即可继续。');
      if (state === 'unknown') throw new Error('暂时无法读取上次钱包交易的结果，原记录已保留，请稍后重试。');
      if (localStorage.getItem(`worknet-sponsor:${intent.id}`)) {
        const previous = await api('setup', intent);
        if (Date.now() / 1000 < previous.validUntil) throw new Error('上次签名仍待确认，请稍后点击同一按钮重试。不会再次充值。');
      }
    }
    // Retire only the pending pointer. Keep all original signature and transaction records.
    assertSession(owner, sessionGeneration); clearSetup(intent.id);
  }
  async function prepare(mode: 'recharge' | 'authorize', publishing = false): Promise<any> {
    if (!owner) throw new Error('请先连接钱包。');
    const current = generation.current;
    const savedKey = `worknet-setup:${owner}`; let prior = localStorage.getItem(savedKey);
    if (mode === 'authorize' && prior && JSON.parse(prior).mode !== 'authorize') {
      await retirePreviousSetup(JSON.parse(prior)); prior = null;
    }
    const fresh = mode === 'authorize' && !prior ? await api('account') : account;
    assertSession(owner, current);
    if (fresh) setAccount(fresh);
    const intent = prior ? JSON.parse(prior) : { id: crypto.randomUUID(), amount: mode === 'authorize' ? renewalAmount(fresh?.budget?.vaultBalance) : parseBudgetAmount(amount), mode };
    if (!intent.amount) throw new Error('预算余额不足以支付本任务奖励，请补足差额。');
    localStorage.setItem(savedKey, JSON.stringify(intent)); setPendingSetup(intent); setAmount(formatUnits(BigInt(intent.amount), 6));
    if (mode !== 'authorize' && await budgetCompleted(intent)) { assertSession(owner, current); await finishSetup(publishing, intent.id); return; }
    const restored = await api('setup', intent);
    assertSession(owner, current);
    if (mode === 'authorize') {
      const chain = await api('account'); assertSession(owner, current);
      if (expiredBudgetPermission(restored, chain.chainTimestamp)) { await retirePreviousSetup(intent); return prepare(mode, publishing); }
    }
    if (await budgetCompleted(intent, restored)) { assertSession(owner, current); await finishSetup(publishing, intent.id); return; }
    if (mode === 'authorize' && Date.now() / 1000 >= restored.validUntil) {
      await retirePreviousSetup(intent); return prepare(mode, publishing);
    }
    setSetup(restored); return restored;
  }
  const finishSetup = async (publishing = false, expectedId?: string) => { clearSetup(expectedId); if (!publishing) toast.success('预算操作已完成，请返回原计划确认发布。'); try { await refresh(); } catch { toast.error('预算操作已完成，状态暂未同步，请稍后刷新。'); } };
  const discardSetup = () => action('discard', async () => {
    const intent = setup ?? pendingSetup; if (!intent) return;
    const journal = localStorage.getItem(`worknet-wallet:${intent.id}`);
    if (journal) {
      const recorded = JSON.parse(journal);
      if (recorded.complete) { await finishSetup(); return; }
      if (recorded.sending || recorded.batchId || recorded.steps?.some((step: any) => step?.sending || step?.hash)) throw new Error('已有钱包操作记录，请恢复原操作或先核对钱包交易，避免重复提交。');
      // Capability checks or an explicitly rejected wallet prompt have no submitted transaction.
    }
    const response = await fetch(`/platform/commands/${intent.id}`, { credentials: 'same-origin', cache: 'no-store' });
    if (response.ok) { const command = await response.json(); if (command.status === 'complete') { await finishSetup(); return; } if (command.status !== 'failed') throw new Error('原操作仍在处理，请等待确认。'); }
    else if (response.status !== 404) throw new Error('无法确认原操作状态，请稍后重试。');
    if (localStorage.getItem(`worknet-sponsor:${intent.id}`) && (!setup || Date.now() / 1000 < setup.validUntil)) throw new Error('已签署的授权仍有效，请恢复原操作，或等它到期后再准备新计划。');
    localStorage.removeItem(`worknet-setup:${owner}`); localStorage.removeItem(`worknet-sponsor:${intent.id}`); setSetup(undefined); setPendingSetup(undefined); setAmount('0.5'); toast.success('已取消未执行的预算操作。');
  });
  async function fund(setup: any, mode: 'sponsor' | 'wallet', publishing = false) {
    if (!owner) return;
    const sessionGeneration = generation.current;
    if (setup.mode === 'authorize' && await authorizationObserved(setup)) { assertSession(owner, sessionGeneration); await finishSetup(publishing, setup.id); return; }
    setPaymentProgress('等待钱包确认…');
    assertSession(owner, sessionGeneration);
    if (mode === 'sponsor') {
      const existing = await fetch(`/platform/commands/${setup.id}`, { credentials: 'same-origin', cache: 'no-store' });
      if (existing.ok) { await waitCommand(setup.id); assertSession(owner, sessionGeneration); await finishSetup(publishing, setup.id); return; }
      if (existing.status !== 404) throw new Error('暂时无法确认原操作的状态，请稍后重试。');
      if (Date.now() / 1000 >= setup.validUntil) throw new Error('赞助授权计划已过期。确认没有已提交的操作后，请重新准备。');
      const key = `worknet-sponsor:${setup.id}`;
      const signature = localStorage.getItem(key);
      if (!signature) throw new Error('之前的代付记录暂未同步，请稍后继续原操作。');
      assertSession(owner, sessionGeneration);
      setPaymentProgress(setup.mode === 'authorize' ? '正在确认授权…' : '正在确认充值…');
      localStorage.setItem(key, signature); await api('setup/sponsor', { id: setup.id, signature }); await waitCommand(setup.id);
    } else {
      const { client, address } = await wallet(owner); assertSession(owner, sessionGeneration);
      const journalKey = `worknet-wallet:${setup.id}`; const journal = JSON.parse(localStorage.getItem(journalKey) ?? '{}');
      const provider = legacyWalletMode ? window.ethereum as any : undefined;
      journal.callCount = setup.calls.length;
      if (!journal.mode && setup.mode === 'authorize' && setup.calls.length === 1) { journal.mode = 'sequential'; localStorage.setItem(journalKey, JSON.stringify(journal)); }
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
          catch (e) { const failure = walletSendFailure(e); if (failure) { journal.sending = false; journal.failure = failure; localStorage.setItem(journalKey, JSON.stringify(journal)); } throw e; }
        }
        let complete = false;
        for (let i = 0; i < 60; i++) {
          const state = await reconcileWalletPayment(setup.id, setup.calls.length);
          if (state === 'complete') { complete = true; Object.assign(journal, JSON.parse(localStorage.getItem(journalKey)!)); break; }
          if (state === 'settled') throw new Error('批量交易未成功，请查看钱包记录。');
          if (state === 'unknown') {
            if (setup.mode === 'authorize' && await waitForAuthorization(setup)) { assertSession(owner, sessionGeneration); await finishSetup(publishing, setup.id); return; }
            throw new Error('暂时无法读取上次钱包交易的结果，原记录已保留，请稍后重试。');
          }
          await new Promise(r => setTimeout(r, 2000));
        }
        if (!complete) throw new Error('批量交易仍待确认，稍后点击同一按钮会查询原操作。');
      } else {
        journal.steps ??= [];
        for (let i = 0; i < setup.calls.length; i++) {
          assertSession(owner, sessionGeneration);
          const entry = journal.steps[i] ?? {};
          if (entry.sending && !entry.hash) {
            if (setup.mode === 'authorize' && await waitForAuthorization(setup)) { assertSession(owner, sessionGeneration); await finishSetup(publishing, setup.id); return; }
            throw new Error('钱包尚未返回上一笔交易 hash，请检查钱包记录，避免重复充值。');
          }
          if (!entry.hash) { entry.sending = true; journal.steps[i] = entry; localStorage.setItem(journalKey, JSON.stringify(journal)); const c = setup.calls[i];
            try { entry.hash = await client.sendTransaction({ account: address, to: c.target, data: c.callData, value: 0n }); entry.sending = false; localStorage.setItem(journalKey, JSON.stringify(journal)); }
            catch (e) { const failure = walletSendFailure(e); if (failure) { entry.sending = false; entry.failure = failure; localStorage.setItem(journalKey, JSON.stringify(journal)); } throw e; }
          }
          setPaymentProgress(`确认中 ${i + 1}/${setup.calls.length}…`);
          let receipt;
          try { receipt = await reader.waitForTransactionReceipt({ hash: entry.hash, timeout: 60000 }); }
          catch (error) {
            if (setup.mode === 'authorize' && await waitForAuthorization(setup)) { assertSession(owner, sessionGeneration); await finishSetup(publishing, setup.id); return; }
            throw error;
          }
          if (receipt.status !== 'success') throw new Error('钱包交易执行失败，请检查交易记录。');
        }
      }
      journal.complete = true; localStorage.setItem(journalKey, JSON.stringify(journal));
    }
    assertSession(owner, sessionGeneration); await finishSetup(publishing, setup.id);
  }
  const recharge = (mode: 'recharge' | 'authorize' = 'recharge') => action('fund', async () => {
    if (checkingBudget) return;
    setPaymentProgress((pendingSetup?.mode ?? mode) === 'authorize' ? '正在准备授权…' : '正在准备充值…');
    const prepared = await prepare(mode); if (!prepared) return;
    const command = await budgetCommand(prepared.id);
    if (command?.status === 'complete') { await finishSetup(); return; }
    const paymentMode = paymentMethod(!!command, !!localStorage.getItem(`worknet-sponsor:${prepared.id}`));
    await fund(prepared, paymentMode);
  });
  const ownerCall = (fn: 'revokeAgent' | 'withdraw' | 'cancelTask' | 'acceptResult' | 'rejectResult', g?: Goal) => action(fn, async () => {
    if (!owner || !account?.vault) return; const { client, address } = await wallet(owner);
    let args: any[] = [config.operator];
    if (fn === 'withdraw') args = [BigInt(account.budget?.vaultBalance ?? '0'), address];
    if (fn === 'cancelTask') args = [BigInt(g!.taskId!)];
    if (fn === 'acceptResult') args = [BigInt(g!.taskId!), BigInt(g!.task.attempt), g!.task.resultHash];
    if (fn === 'rejectResult') { const reason = window.prompt(tr('请输入拒绝当前交付的原因')); if (!reason?.trim()) return; const { keccak256, stringToHex } = await import('viem'); args = [BigInt(g!.taskId!), BigInt(g!.task.attempt), g!.task.resultHash, keccak256(stringToHex(reason))]; }
    const data = encodeFunctionData({ abi: requesterVaultAbi, functionName: fn, args } as any);
    const hash = await client.sendTransaction({ account: address, to: account.vault, data }); const receipt = await reader.waitForTransactionReceipt({ hash }); if (receipt.status !== 'success') throw new Error('链上操作未成功。'); await refresh(); toast.success('钱包操作已确认，平台将同步最新任务状态。');
  });
  const current = goals.find(g => g.id === selected);
  const renewalLimit = renewalAmount(account?.budget?.vaultBalance) ?? '0';
  const needsPaymentConfirmation = !!current && !publicationBudgetIssue(account?.budget, current.input.reward) && !!taskBudgetIssue(account?.budget, current.input.reward);
  const hasActiveTasks = goals.some(g => g.taskId && Number(g.task?.status ?? 0) < 3);
  const savedPublicationId = current ? localStorage.getItem(`worknet-launch:${owner}:${current.id}`) : null;
  const hasRecoverablePublication = !!current && (current.publication?.id && current.publication.status !== 'failed' || savedPublicationId && !(current.publication?.status === 'failed' && current.publication.id === savedPublicationId));
  const budgetIssue = current && !hasRecoverablePublication ? publicationBudgetIssue(account?.budget, current.input.reward) : undefined;
  const publicationPending = !!current && !current.taskId && ['queued', 'processing'].includes(current.publication?.status ?? ''); const online = config?.health && Date.now() - config.health.updatedAt < 120000 && config.health.ready;
  const navigate = (next: View) => { if (next !== 'home') setEditingDraft(undefined); location.hash = platformHash({ view: next }); };
  const startNewTask = () => { setEditingDraft(undefined); setComposerKey(k => k + 1); navigate('home'); };
  const openGoal = (id: string) => { location.hash = platformHash({ view, goal: id }); };
  return <div className="workspace-shell platform-shell">
    <aside className="rail"><a href="/" aria-label={tr("Worknet 首页")}><Brand/></a><div className="platform-identity"><span className="identity-mark"><Icon name="wallet"/></span><div><strong>{owner ? short(owner) : tr("你的独立账户")}</strong><small>{owner ? tr("个人账户") : tr("使用通行密钥登录")}</small></div></div><button className="button primary new-goal" onClick={startNewTask}><Icon name="plus" size={17}/>{tr("发布新任务")}</button><nav aria-label={tr("主导航")}>{([['home','goal',tr("我的任务")],['deliveries','file',tr("交付文档")],['budget','wallet',tr("预算与账户")],['taker','grid',tr("接单")]] as const).map(([id,icon,label]) => <button key={id} className={view === id ? 'active' : ''} onClick={() => navigate(id)}><Icon name={icon}/>{label}</button>)}</nav><div className="rail-bottom"><div className="connection-card"><span className={`status-dot ${online ? 'online' : ''}`}/><div>{online ? tr("任务协调服务在线") : tr("正在检查服务")}<small>{tr("关闭页面后任务仍可继续")}</small></div></div></div></aside>
    <MeraLogin open={loginOpen} busy={busy==='login'} error={loginError} onChoose={mode=>void loginMera(mode)} onClose={()=>setLoginOpen(false)}/><main className="workspace-main"><header className="topbar"><span className="breadcrumb">Worknet / {view === 'taker' ? tr("接单") : view === 'budget' ? tr("预算与账户") : view === 'deliveries' ? tr("交付文档") : tr("我的任务")}</span><span className="mobile-brand"><Brand/></span><div className="top-actions"><LanguageSwitcher/><span className="testnet-label">Monad Testnet</span>{owner&&<ActivityPanel key={owner} owner={owner} onOpen={(kind,id)=>{if(kind==='run'){location.hash = platformHash({ view: 'taker' });setRunTarget({id,seq:Date.now()});}else{location.hash = platformHash({ goal: id });void refresh().catch(e=>toast.error(e.message));}}}/>}{owner ? <button className="button subtle" onClick={() => void action('logout', async () => { await api('logout', {}); lockMera(); setOwner(undefined); })} disabled={!!busy}>{short(owner)}<Icon name="logout" size={15}/></button> : <button className="button primary" onClick={() => void connect()} disabled={!!busy}>{busy === 'login' ? tr("等待通行密钥…") : tr("登录")}</button>}</div></header>
    <div className="page-body">{syncError && <div className="feedback error" role="status"><Icon name="link" size={18}/><span>{tr(syncError)}</span></div>}
    {view === 'taker' ? <TakerPanel key={owner??'anonymous'} owner={owner} account={account} wallet={wallet} connect={connect} createAgentAccount={()=>{setLoginError('');setLoginOpen(true);return loginMera('create');}} restoreAgentAccount={()=>{setLoginError('');setLoginOpen(true);return loginMera('signin');}} config={config} target={runTarget}/> : current ? <><button className="back-button" onClick={() => { location.hash = platformHash({ view }); }}>{tr("返回我的任务")}</button><div className="detail-heading"><span className={`pill ${current.status}`}>{tr(status(current))}</span><h1>{current.input.goal}</h1><p>{tr("任务奖励")}{settlementMoney(current.input.reward)} test USDC</p></div>
      {current.input.agreement && <section className="saved-agreement"><h2>{tr("已约定的交付与验收")}</h2><p>{current.input.agreement.deliverable}</p>{current.input.agreement.intent && <div className="saved-intent"><h3>{tr('明确后的目标')}</h3><p>{current.input.agreement.intent.objective}</p>{([['constraints','必须遵守的约束'],['assumptions','当前假设'],['evidenceRequirements','需要提供的证据']] as const).map(([field,label]) => current.input.agreement!.intent![field].length > 0 && <div key={field}><h3>{tr(label)}</h3><ul>{current.input.agreement!.intent![field].map((item,i)=><li key={i}>{item}</li>)}</ul></div>)}</div>}<ol>{current.input.agreement.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ol>{current.input.kind === 'research' && <p>{tr("基础要求：回答约定目标，结论由指定资料的精确引文支持。此要求始终保留。")}</p>}</section>}
      {!current.taskId && !hasRecoverablePublication && <button className="button subtle" disabled={!!busy} onClick={() => {setEditingDraft({goal:current.input.goal,kind:current.input.kind,reward:formatUnits(BigInt(current.input.reward),6),sources:current.input.sourceUrls?.join('\n') ?? '',fromBlock:current.input.fromBlock ?? '',toBlock:current.input.toBlock ?? '',...(current.input.agreement?{agreement:current.input.agreement}:{})});setComposerKey(k=>k+1);navigate('home');}}>{tr("修改约定")}</button>}
      {!current.taskId ? <div className="plan-layout"><article className="plan-paper"><h2>{tr("这次任务的交付约定")}</h2>{(current.publication?.error || current.error) && <p className="document-warning" role="status">{tr(current.publication?.error || current.error)}</p>}{publicationPending && <p className="document-warning">{tr("发布请求已收到，正在等待后台确认；无需重复提交。")}</p>}<div className="platform-brief"><Icon name={current.input.kind === 'research' ? 'spark' : 'grid'} size={32}/><div><h3>{current.input.kind === 'general' ? tr("按目标交付的自由任务") : current.input.kind === 'research' ? tr("有来源引用的研究简报") : tr("可独立复算的转账分析")}</h3><p>{current.input.kind === 'general' ? tr("外部 Agent 按确认的 intent 执行；Jev 多节点依据交付物与证据评定完成度。") : current.input.kind === 'research' ? tr("阅读指定资料，形成回答目标的简报；重新抓取来源并由独立 Judge 审核。") : tr("完整查询指定区间的测试 USDC Transfer，交付次数与原始金额，并独立复算。")}</p></div></div>{current.input.sourceUrls?.map(uri => <p key={uri}><a href={safeSource(uri)} target="_blank" rel="noreferrer">{uri}</a></p>)}<p>{(current.input as any).execution === 'market' ? tr("发布到接单大厅，由外部 Agent 领取和执行。") : tr("此为旧版平台执行计划，请修改约定后开放接单。")}{tr("任务与交付公开保存。执行期限 1 小时，提交后审核窗口 10 分钟。审核超时可能付款，不等于验证通过。")}</p></article><aside className="plan-confirm"><Icon name="wallet" size={26}/><h2>{tr("确认并发布")}</h2><p className="execution-confirm">{tr("发布方式：")}<strong>{tr("开放接单")}</strong></p><div className="plan-price">{settlementMoney(current.input.reward)}<span>test USDC</span></div><p>{tr("奖励将从你的独立预算托管到任务合约。")}</p>{current.input.kind !== 'analysis' && config?.quorum && <QuorumTerms/>}<p>{tr("如需钱包交易确认，手续费以钱包显示为准；完成后自动继续发布，无需再次充值 USDC。")}</p>{needsPaymentConfirmation && <details className="recharge-options"><summary>{tr("本次钱包确认的付款范围")}</summary><p>{tr("24 小时内累计最多")}<Money amount={renewalLimit}/>{tr("，单笔最多")}<Money amount={BigInt(renewalLimit) < 200000n ? renewalLimit : '200000'}/> test USDC。</p>{hasActiveTasks && <p>{tr("你还有进行中的任务；更新授权后，这些任务可能需要你手动审核。")}</p>}</details>}<button className="button primary full-width" disabled={!!busy || publicationPending || !!budgetIssue || current.input.execution !== 'market' && !hasRecoverablePublication} onClick={() => void launch(current)}>{busy === 'launch' || publicationPending ? tr(paymentProgress) || tr("正在确认发布…") : current.publication?.status === 'failed' ? tr("重试发布") : tr("确认并发布")}</button>{budgetIssue && <><p role="status">{tr(budgetIssue)}</p><button className="text-button full-width" onClick={() => navigate('budget')}>{tr("充值")}</button><button className="text-button full-width" disabled={!!busy} onClick={() => void action('refresh-budget', refresh)}>{tr("刷新预算状态")}</button></>}</aside></div> : <>
      <MarketRules/>{current.input.kind !== 'analysis' && config?.quorum && <QuorumTerms/>}<QuorumPanel ended={Number(current.task?.status)>=3} evidence={current.evidence} settlement={current.settlement}/><RecoveryHint item={current} requester/><div className="execution-progress">{[tr("等待接单"),tr("执行"),tr("审核"),tr("交付")].map((label,i) => <div key={label} className={Number(current.task?.status ?? -1)<=3 && Number(current.task?.status ?? -1) >= i ? 'done' : ''}><span>{i + 1}</span><b>{label}</b></div>)}</div>{current.error && <p className="document-warning">{tr(current.error)}</p>}
      {Number(current.task?.attempt) > 0 && Number(current.task?.status) !== 0 && <TaskProgress updates={current.progress ?? []} attempt={String(current.task.attempt)} active={Number(current.task.status) === 1} leaseExpiresAt={current.task.claimLeaseExpiresAt}/>}
      {current.result && isPrivateOutput(current.result.output) ? <PrivateDelivery key={`${owner}:${current.taskId}:${current.result.attempt}`} result={current.result} delivery={current.spec?.delivery} canUnlock/> : current.result ? <article className="deliverable"><div className="deliverable-head"><Icon name="file"/><h2>{tr("任务交付")}</h2><span className={`pill ${current.evidence?.verdict === 'accept' && current.audit?.verdict !== 'reject' ? 'completed' : 'attention'}`}>{current.evidence?.verdict === 'scored' ? tr("已评定完成度") : current.audit?.verdict === 'reject' ? tr("复核未通过") : current.evidence?.verdict === 'accept' ? tr("独立检查通过") : tr("尚未通过检查")}</span></div><div className="result-document">{current.input.kind === 'general' ? <GeneralDelivery output={current.result.output}/> : current.input.kind === 'analysis' ? <div className="analysis-result"><div><span>{tr("转账次数")}</span><strong>{current.result.output.eventCount}</strong></div><div><span>{tr("转账总额")}</span><strong><Money amount={current.result.output.totalAmountBaseUnits}/><small>test USDC</small></strong></div></div> : <><p className="research-summary">{current.result.output.summary}</p>{current.result.output.findings?.map((f: any,i: number) => <section className="finding" key={i}><h3>{f.title}</h3><p>{f.claim}</p><blockquote>{f.quote}</blockquote><a href={safeSource(f.sourceUri)} target="_blank" rel="noreferrer">{tr("查看来源")}</a></section>)}</>}</div></article> : <div className="empty-state"><Icon name="clock" size={30}/><h3>{Number(current.task?.status)>=4?tr("任务已结束"):current.task?.status===3?tr("任务已结算，等待记录同步"):tr("任务正在平台上推进")}</h3><p>{Number(current.task?.status)>=4?tr("本任务不会继续执行，请核对退款与预算记录。"):tr("你可以离开页面，稍后回到这里阅读交付。")}</p></div>}
      <ProtocolEvidence result={current.result} payments={current.toolPayments??[]} storageUrl={config?.storageUrl}/>
      {current.task?.status === 0 && <button className="button subtle" disabled={!!busy} onClick={() => void ownerCall('cancelTask', current)}>{tr("用钱包取消未领取任务")}</button>}
      {current.task?.status === 2 && Number(current.task.reviewDeadline)*1000>Date.now() && <div className="platform-owner-review"><h3>{tr("Owner 手动接管")}</h3><p>{tr("当前提交的审核截止时间：")}{new Date(Number(current.task.reviewDeadline) * 1000).toLocaleString(locale())}{tr("。人工接受将付款给当前提交者。")}</p><button className="button subtle" disabled={!!busy} onClick={() => void ownerCall('acceptResult', current)}>{tr("接受当前交付并付款")}</button><button className="text-button danger" disabled={!!busy} onClick={() => void ownerCall('rejectResult', current)}>{tr("拒绝当前交付")}</button></div>}
      <details className="technical"><summary>{tr("执行与验证记录")}</summary><dl><dt>{tr("任务")}</dt><dd>#{current.taskId} / attempt {current.task?.attempt}</dd><dt>{tr("领取地址")}</dt><dd>{current.task?.worker}</dd><dt>Result hash</dt><dd>{current.task?.resultHash}</dd></dl>{(current.verificationHistory?.length ? current.verificationHistory : current.evidence ? [current.evidence] : []).map((e: any,j: number) => <section key={j}><h3>{tr("第")}{e.attempt}{tr("轮：")}{e.verdict === 'scored' ? tr("已评定完成度") : e.verdict === 'unverifiable' ? tr("裁判未达到门槛") : e.verdict === 'accept' ? tr("自动审核接受") : tr("自动审核拒绝")}</h3>{e.checks?.map((c: any,i: number) => <p key={i}>{c.passed ? tr("通过") : tr("未通过")}：{tr(c.detail)}</p>)}</section>)}{current.events?.map((e,i) => <p key={i}>{e.event} <a href={txUrl(e.transactionHash)} target="_blank" rel="noreferrer">{tr("查看交易")}</a></p>)}</details></>}
    </> : view === 'home' ? <><div className="home-heading"><span className="heading-symbol"><Icon name="goal" size={30}/></span><h1>{tr("让目标，成为交付。")}</h1><p>{tr("说出你的目标，约定价格与验收标准，让外部 Agent 为你完成。")}</p></div>{!owner && <div className="platform-welcome"><div><h2>{tr("从你的通行密钥开始")}</h2><p>{tr("登录签名仅用于确认身份。发布前，你会看到工作内容、奖励和验收方式。")}</p></div><button className="button primary" disabled={!!busy} onClick={() => void connect()}>{tr("登录或创建账户")}</button></div>}
      {owner && <BudgetReminder account={account} onSetup={()=>navigate('budget')}/>}
      <TaskComposer key={composerKey} initial={editingDraft} owner={owner} busy={!!busy} onLogin={connect} onPrepare={input => api('brief', input)} onPlan={plan} privacy={<div className="private-delivery-option"><label><input type="checkbox" checked={privateDelivery && !legacyWalletMode && !!config?.privacy?.reviewPublicKey} disabled={legacyWalletMode||!config?.privacy?.reviewPublicKey} onChange={e=>setPrivateDelivery(e.target.checked)}/>{tr("交付物使用通行密钥加密")}</label><p>{config?.privacy?.reviewPublicKey ? tr("发布时创建此任务的独立钥匙。执行器和审核服务可读取处理内容，公开存储仅保留加密交付。") : tr("当前环境尚未启用私有交付，本次交付将公开保存。")}</p></div>}/>
      <section className="recent-section"><div className="section-heading"><h2>{tr("我的任务")}</h2><span>{tr("仅显示当前账户的目标")}</span></div><GoalRows goals={goals} onOpen={openGoal}/></section>
    </> : view === 'deliveries' ? <><div className="page-heading"><h1>{tr("交付文档")}</h1><p>{tr("任务成果、来源和检查记录，都保存在这里。")}</p></div><GoalRows goals={goals.filter(g => g.result)} onOpen={openGoal}/></> : <><div className="page-heading budget-page-heading"><h1>{tr("任务预算")}</h1><p>{tr("充值后，用于支付你发布的任务。")}</p></div>{!owner ? <button className="button primary" disabled={!!busy} onClick={() => void connect()}>{tr("登录")}</button> : <><AccountSetup account={account} onContinue={()=>navigate('home')}/><BudgetPanel refresh={refresh} account={account} owner={owner} operator={config?.operator} amount={amount} pending={pendingSetup} busy={!!busy} checking={checkingBudget} progress={paymentProgress} hasActiveTasks={hasActiveTasks} setAmount={setAmount} recharge={() => void recharge()} cancel={() => void discardSetup()} withdraw={() => void ownerCall('withdraw')} revoke={() => void ownerCall('revokeAgent')}/></>}
    </>}
    <PlatformFooter/></div></main></div>;
}
function GoalRows({ goals, onOpen }: { goals: Goal[]; onOpen(id: string): void }) { return <div className="goal-list">{goals.map(g => <button key={g.id} className="goal-row" onClick={() => onOpen(g.id)}><span className={`goal-row-icon ${g.status}`}><Icon name={g.status === 'completed' || g.status === 'settled' ? 'check' : g.status === 'draft' ? 'file' : 'clock'}/></span><span className="goal-row-copy"><strong>{g.input.goal}</strong><small>{g.input.kind === 'general' ? tr("自由任务") : g.input.kind === 'research' ? tr("资料研究") : tr("链上分析")} · {relative(g.createdAt)} · {settlementMoney(g.input.reward)} test USDC</small></span><span className={`pill ${g.status}`}>{tr(status(g))}</span><Icon name="chevron"/></button>)}{!goals.length && <div className="empty-inline"><Icon name="file"/><span>{tr("这里还没有任务。先描述希望获得的结果。")}</span></div>}</div>; }
