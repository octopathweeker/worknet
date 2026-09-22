import {t as tr,locale} from './i18n';
import React from 'react';
import {formatUnits} from 'viem';
export function MarketRules(){return <details className="market-rules"><summary>{tr("接单与验收规则")}</summary><ul><li>{tr("开放任务允许公开竞争，以链上首次成功领取为准。准备计划或选择执行器不锁定名额。")}</li><li>{tr("领取后须在租约内提交；过期释放后，新领取使用新轮次。旧授权与旧交付不能替代新轮次。")}</li><li>{tr("首次保存的交付固定不变。Requester 可在审核窗口内接受或拒绝；平台独立审核也可能出错。")}</li><li>{tr("审核超时后可按合约结算给提交者，这不代表质量通过。Requester 应在截止前查看交付并在必要时接管。")}</li><li>{tr("停止执行、撤销权限不撤回已签名交易或托管承诺。目前没有押金、声誉、指定 taker 的链上锁或争议仲裁。")}</li><li>{tr("平台在两轮执行未完成后会尝试取消并退款，这是平台运营规则，不是合约的轮数限制。")}</li></ul><a href="/downloads/market-guide.md" target="_blank" rel="noreferrer">{tr("查看试用与恢复手册")}</a></details>;}
export function ServiceStatus({config}:{config:any}){
 if(!config)return null;const health=config.health;const stale=!health||Date.now()-health.updatedAt>120000;const gas=health?.gasBudget;
 return <details className="market-rules"><summary>{tr("服务状态与赞助额度")}</summary><p>{stale?tr("服务状态暂未同步；原任务和授权记录仍保留，请刷新后核对。"):health.ready?tr("云端服务最近检查正常。"):tr("云端服务需要处理；请保留原任务，必要时使用钱包接管。")}</p>{gas&&<p>{tr("平台今日 gas 预算剩余")}{formatUnits(BigInt(gas.remainingWei),18)} / {formatUnits(BigInt(gas.limitWei),18)} MON；{new Date(gas.resetsAt).toLocaleString(locale())}{tr("重置。这是平台共享额度，不能保证每笔交易获得赞助。")}</p>}<p>{tr("赞助不可用时，已领取任务可在有效租约内转为钱包接管；普通交易需要自己的 test MON。托管模型额度耗尽时不会切换付费模型。")}</p></details>;
}
export function RecoveryHint({item,requester=false,now=Date.now()}:{item:any;requester?:boolean;now?:number}){
 const task=item.task;if(!task)return null;const status=Number(task.status);const seconds=now/1000;let text='';
 if(item.superseded)text='本轮已结束。可保留交付作参考；如任务重新开放，需重新核对并领取新轮次。';
 else if(status===0)text=Number(task.taskDeadline)<=seconds?'任务期限已过，等待链上到期处理；不要继续领取。':requester?'尚未领取，可等待接单或用钱包取消。取消成功后奖励退回任务预算。':'以链上成功领取为准。准备计划不会为你预留名额。';
 else if(status===1)text=Number(task.claimLeaseExpiresAt)<=seconds?'本轮领取租约已到期。刷新并等待链上释放；旧轮次无法再提交。':requester?'等待接单者在租约内提交；已领取任务不能直接取消。':`本轮提交截止：${new Date(Number(task.claimLeaseExpiresAt)*1000).toLocaleString(locale())}。${item.revoked||['failed','stopped'].includes(item.hosted?.status)?'执行已停止或失败，可在下方转为钱包接管。':'执行器离线或赞助不可用时，可在下方转为钱包接管。'}`;
 else if(status===2)text=`审核截止：${new Date(Number(task.reviewDeadline)*1000).toLocaleString(locale())}。${seconds>=Number(task.reviewDeadline)?'期限已过，等待链上结算；不要再尝试接受或拒绝。':requester?'自动审核不可用时，请在期限内用下方 Owner 操作接管；超时可能付款。':'等待 requester 审核，期间不需要重复提交。'} 超时付款不代表质量通过。`;
 else if(status===3)text='任务已结算。付款与质量审核是两项独立记录，请同时核对交付、审核和付款原因。';
 else if(status>=4)text='任务已取消或到期。不会继续执行；退款以链上记录和 requester 预算余额为准。';
 return text?<p className="document-warning" role="status">{tr(text)}</p>:null;
}
