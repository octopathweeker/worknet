import React, { useEffect, useRef, useState } from 'react';
import { t as tr, locale } from './i18n';
import { Icon } from './components';
import { draftBasis, emptyTaskDraft, asGeneralDraft, presetDraft, draftParameters, readTaskDraft, clearTaskDraft, taskExamples, taskReward, type Brief, type TaskDraft } from './platform-draft';

export function TaskComposer({ owner, busy, initial, onLogin, onPrepare, onPlan, privacy }: {
  owner: string | undefined; busy: boolean; initial?: TaskDraft | undefined;
  onLogin(): void; onPrepare(input: unknown): Promise<Brief>; onPlan(draft: TaskDraft): Promise<void>; privacy: React.ReactNode;
}) {
  const [draft, setDraft] = useState(() => initial ?? emptyTaskDraft());
  const [savedDraft, setSavedDraft] = useState(() => { if (initial) return undefined; const saved = readTaskDraft(); return saved.goal.trim() ? saved : undefined; });
  const [dirty, setDirty] = useState(!!initial);
  const [step, setStep] = useState(initial?.agreement && (initial.kind !== 'general' || initial.agreement.intent) ? 2 : 1); const [preparing, setPreparing] = useState(false);
  const [feedback, setFeedback] = useState<Brief>(); const [error, setError] = useState('');
  const goalInput = useRef<HTMLTextAreaElement>(null); const agreementHeading = useRef<HTMLHeadingElement>(null);
  const locked = busy || preparing;
  useEffect(() => { if (!dirty) return; try { localStorage.setItem('worknet-platform-draft', JSON.stringify({ ...draft, flowVersion: 2 })); } catch { /* Optional persistence. */ } }, [draft, dirty]);
  useEffect(() => { if (step === 2) agreementHeading.current?.focus(); }, [step]);
  const update = (patch: Partial<TaskDraft>) => { setDirty(true); setSavedDraft(undefined); setDraft(d => ({ ...d, ...patch })); setError(''); };
  const replace = (next: TaskDraft) => { setDirty(true); setSavedDraft(undefined); setDraft(next); setFeedback(undefined); setError(''); setStep(1); goalInput.current?.focus(); };
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (locked) return;
    try { taskReward(draft.reward); } catch (e) { setError((e as Error).message); return; }
    if (!owner) { onLogin(); return; }
    if (step === 2) { const intent = draft.agreement?.intent; if (intent && [intent.constraints,intent.assumptions,intent.evidenceRequirements].some(items => items.filter(s => s.trim()).length > 8 || items.some(s => s.trim().length > 300))) { setError('每类约定最多 8 项，每项最多 300 字。'); return; } await onPlan(intent ? { ...draft, agreement: { ...draft.agreement!, intent: { ...intent, constraints: intent.constraints.map(s => s.trim()).filter(Boolean), assumptions: intent.assumptions.map(s => s.trim()).filter(Boolean), evidenceRequirements: intent.evidenceRequirements.map(s => s.trim()).filter(Boolean) } } } : draft); return; }
    if (draft.agreement && (draft.kind !== 'general' || draft.agreement.intent) && draft.basis === draftBasis(draft)) { setStep(2); return; }
    setPreparing(true); setError(''); setFeedback(undefined);
    try {
      const result = await onPrepare({ goal: draft.goal, kind: draft.kind, ...draftParameters(draft), language: locale() === 'en-US' ? 'en' : 'zh' });
      setFeedback(result);
      if (result.status === 'ready') { setDirty(true); setDraft(d => ({ ...d, kind: result.kind, agreement: result.agreement, basis: draftBasis(d) })); setStep(2); }
    } catch (e) { setError((e as Error).message); }
    finally { setPreparing(false); }
  }
  return <>
    {savedDraft && <aside className="draft-recovery"><div><strong>{tr('有一份未完成的草稿')}</strong><p>{savedDraft.goal}</p></div><div className="draft-actions"><button type="button" className="button subtle" disabled={locked} onClick={() => { const saved = savedDraft; replace(saved); if (saved.agreement && saved.basis === draftBasis(saved) && (saved.kind !== 'general' || saved.agreement.intent)) setStep(2); }}>{tr('恢复草稿')}</button><button type="button" className="text-button" aria-label={tr('删除草稿')} onClick={() => { clearTaskDraft(); setSavedDraft(undefined); }}>{tr('删除')}</button></div></aside>}
    <form className="goal-composer task-composer" onSubmit={e => void submit(e)} onInvalid={e => (e.target as HTMLElement).closest('details')?.setAttribute('open', '')}>
      <fieldset disabled={locked} className="composer-body">
        <ol className="composer-steps" aria-label={tr('发布步骤')}><li aria-current={step === 1 ? 'step' : undefined}>{tr('1 · 目标与价格')}</li><li aria-current={step === 2 ? 'step' : undefined}>{tr('2 · 交付与验收')}</li><li>{tr('3 · 确认发布')}</li></ol>
        {step === 1 ? <>
          <div className="composer-kind"><span className="pill">{draft.kind === 'general' ? tr('自由任务') : draft.kind === 'analysis' ? tr('预设 · USDC 转账统计') : tr('预设 · Monad 文档研究')}</span>{draft.kind !== 'general' && <button type="button" className="text-button" onClick={() => replace(asGeneralDraft(draft))}>{tr('改为自由任务')}</button>}</div>
          <label className="composer-label" htmlFor="platform-goal">{tr('你想完成什么？')}</label>
          <textarea ref={goalInput} id="platform-goal" value={draft.goal} onChange={e => update({ goal: e.target.value })} minLength={8} maxLength={2000} required placeholder={tr('说说你的目标、结果准备用在哪里，以及你最关心什么。')}/>
          <div className="composer-price platform-fields"><label htmlFor="platform-reward">{tr('你愿意支付多少？')}<div className="reward-input"><input id="platform-reward" value={draft.reward} onChange={e => update({ reward: e.target.value })} inputMode="decimal" required aria-describedby="reward-help"/><span>test USDC</span></div></label><p id="reward-help">{tr('任务奖励 0.01–0.20 test USDC。确认发布时托管；链上手续费另计。')}</p></div>
          <p className="composer-scope">{draft.kind === 'general' ? tr('描述你自己的目标，平台会整理交付与验收标准，由外部 Agent 执行、Jev 多节点审核。') : draft.kind === 'analysis' ? tr('此预设统计测试 USDC 的转账次数和总金额，结果按区块范围独立复算。') : tr('此预设基于指定 Monad 文档生成研究简报，核对原文引用并审核交付。')}</p>
          {draft.kind === 'general' && <details className="source-settings" open={feedback?.status === 'needs_input'}><summary>{tr('参考资料（选填）')}<Icon name="chevron" size={14}/></summary><div className="platform-fields">
            <label htmlFor="platform-general-sources">{tr('参考链接（每行一条，最多 16 条）')}<textarea id="platform-general-sources" value={draft.sources} onChange={e => update({ sources: e.target.value })} placeholder="https://…"/></label>
            <p>{tr('可提供背景资料、示例或相关网站；也可以留空，让 Agent 自行查找。')}</p>
          </div></details>}
          {draft.kind === 'research' && <section className="preset-settings platform-fields" aria-label={tr('文档研究设置')}>
            <label htmlFor="platform-research-sources">{tr('研究来源（必填，每行一条，最多 3 条）')}<textarea id="platform-research-sources" value={draft.sources} onChange={e => update({ sources: e.target.value })} required placeholder="https://docs.monad.xyz/…"/></label>
            <p>{tr('此预设仅使用 docs.monad.xyz 的公开文档，结论需有精确原文引用。研究其他网站时，可改为自由任务。')}</p>
          </section>}
          {draft.kind === 'analysis' && <section className="preset-settings platform-fields" aria-label={tr('转账统计设置')}>
            <h3>{tr('统计区块范围')}</h3>
            <div className="field-pair"><label htmlFor="platform-from-block">{tr('起始区块（选填）')}<input id="platform-from-block" value={draft.fromBlock} onChange={e => update({ fromBlock: e.target.value })} inputMode="numeric" pattern="[0-9]{1,16}"/></label><label htmlFor="platform-to-block">{tr('结束区块（选填）')}<input id="platform-to-block" value={draft.toBlock} onChange={e => update({ toBlock: e.target.value })} inputMode="numeric" pattern="[0-9]{1,16}"/></label></div>
            <p>{tr('统计默认使用最近 100 个已确认区块；指定范围最多 1,001 个区块。')}</p>
          </section>}
        </> : <div className="agreement-editor platform-fields">
          <h2 tabIndex={-1} ref={agreementHeading}>{tr('把完成的标准说清楚')}</h2><p className="agreement-goal">{draft.goal}</p><span className="pill">{draft.kind === 'general' ? tr('自由任务 · Jev 多节点验收') : tr('预设任务 · 专用验收规则')}</span>
          <p>{tr('任务奖励')}：<strong>{draft.reward} test USDC</strong> <button type="button" className="text-button" onClick={() => setStep(1)}>{tr('修改目标或价格')}</button></p>
          <label>{tr('你将收到什么')}<textarea value={draft.agreement?.deliverable ?? ''} readOnly={draft.kind === 'analysis'} onChange={e => update({ agreement: { ...draft.agreement!, deliverable: e.target.value } })} required maxLength={1000}/></label>
          <h3>{tr('满足哪些条件才算完成？')}</h3><p>{draft.kind !== 'analysis' ? tr('逐项修改系统拟定的标准。发布后，执行 Agent 和审核方使用同一份约定。') : tr('转账统计按以下固定规则独立复算；暂不支持额外指标或主观验收。')}</p>
          {draft.agreement?.acceptanceCriteria.map((criterion, index) => <div className="criterion-row" key={index}><label><span>{tr('验收项 {0}', [index + 1])}</span><textarea value={criterion} readOnly={draft.kind === 'analysis'} maxLength={300} required onChange={e => update({ agreement: { ...draft.agreement!, acceptanceCriteria: draft.agreement!.acceptanceCriteria.map((c, i) => i === index ? e.target.value : c) } })}/></label>{draft.kind !== 'analysis' && <button type="button" className="text-button" aria-label={tr('删除验收项 {0}', [index + 1])} disabled={draft.agreement!.acceptanceCriteria.length <= 1} onClick={() => update({ agreement: { ...draft.agreement!, acceptanceCriteria: draft.agreement!.acceptanceCriteria.filter((_, i) => i !== index) } })}>{tr('删除')}</button>}</div>)}
          {draft.kind !== 'analysis' && <><button type="button" className="button subtle" disabled={(draft.agreement?.acceptanceCriteria.length ?? 0) >= 8} onClick={() => update({ agreement: { ...draft.agreement!, acceptanceCriteria: [...draft.agreement!.acceptanceCriteria, ''] } })}>{tr('添加验收项')}</button>{draft.kind === 'research' && <p>{tr('基础要求：回答约定目标，结论由指定资料的精确引文支持。此要求始终保留。')}</p>}</>}
          {draft.kind === 'general' && draft.agreement?.intent && <div className="intent-editor">
            <h3>{tr('标准化任务约定')}</h3>
            <label>{tr('明确后的目标')}<textarea required maxLength={2000} value={draft.agreement.intent.objective} onChange={e => update({ agreement: { ...draft.agreement!, intent: { ...draft.agreement!.intent!, objective: e.target.value } } })}/></label>
            {([['constraints', '必须遵守的约束'], ['assumptions', '当前假设'], ['evidenceRequirements', '需要提供的证据']] as const).map(([field, label]) => <label key={field}>{tr(label)}<textarea value={draft.agreement!.intent![field].join('\n')} maxLength={2407} onChange={e => update({ agreement: { ...draft.agreement!, intent: { ...draft.agreement!.intent!, [field]: e.target.value.split('\n') } } })}/></label>)}
            <p>{tr('每行一项，最多 8 项；没有要求可以留空。假设不代表你已经提供的信息，可在发布前修改。')}</p>
            <p>{tr('平台解析需求；Jev 多节点按确认后的目标、约束、验收项和证据评分。平台不保证一定有人接单。')}</p>
          </div>}
          <p>{tr('发布到接单大厅，由外部 Agent 领取和执行。')}</p>
          {privacy}
        </div>}
        {feedback && feedback.status !== 'ready' && <div className="composer-feedback" role="status"><strong>{feedback.status === 'unsupported' ? tr('这个目标暂时无法承接') : tr('还需要补充一点信息')}</strong><p>{feedback.reason}</p>{feedback.status === 'needs_input' && <ul>{feedback.questions.map(q => <li key={q}>{q}</li>)}</ul>}<p>{tr('请在上方补充或调整目标，再重新拟定。当前没有发布任务或托管奖励。')}</p></div>}
        {error && <p className="composer-feedback field-error" role="alert">{tr(error)}</p>}
        <div className="composer-footer"><span>{tr('先确认约定，再托管奖励')}</span><button className="button primary" disabled={locked || draft.goal.trim().length < 8}>{preparing ? tr('正在拟定交付与验收…') : busy ? tr('正在准备…') : !owner ? tr('登录并继续') : step === 1 ? tr('拟定交付与验收') : tr('核对并继续')}<Icon name="arrow" size={17}/></button></div>
      </fieldset>
    </form>
    {step === 1 && <section className="starter-section platform-starters" aria-labelledby="platform-starters-title"><div className="section-heading"><h2 id="platform-starters-title">{tr('也可以从预设任务开始')}</h2><span>{tr('使用已有交付格式和专用验收规则')}</span></div><div className="starter-grid">{taskExamples.map((item, i) => <button type="button" disabled={locked} key={item.title} className="starter" onClick={() => { replace(presetDraft(draft, item)); }}><span className={`starter-icon tone-${i}`}><Icon name={item.icon}/></span><strong>{tr(item.title)}</strong><Icon name="arrow" size={17}/></button>)}</div></section>}
  </>;
}
