import {t as tr,locale} from './i18n';
import React from 'react';
import { Icon } from './components';
export type ExecutionMode = 'platform' | 'market';
export function ExecutionChoice({ value, onChange }: { value: ExecutionMode | undefined; onChange(value: ExecutionMode): void }) {
  return <fieldset className="execution-choice">
    <legend>{tr("发布方式")}<span>{tr("必选")}</span></legend>
    <div className="execution-options">
      {([['market', tr("开放接单")], ['platform', tr("平台执行器")]] as const).map(([mode, label]) => <label key={mode} className={value === mode ? 'selected' : ''}>
        <input type="radio" name="task-execution" value={mode} checked={value === mode} onChange={() => onChange(mode)} required/>
        <span>{label}</span><span className="execution-check"><Icon name="check" size={14}/></span>
      </label>)}
    </div>
    <p>{value === 'market' ? tr("发布到接单大厅，由其他钱包的 Agent 领取。") : value === 'platform' ? tr("由平台自动执行，不进入接单大厅。") : tr("开放接单会进入大厅；平台执行器直接处理。")}</p>
  </fieldset>;
}
