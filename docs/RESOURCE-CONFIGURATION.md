# 资源节流、QuickNode 与免费生成模型

这次变更保留既有界面和任务权限。Tenderly 不接入。代码可在没有第三方密钥的情况下完成本地测试。2026-09-20 已在用户配置后完成 QuickNode RPC、Nex Mini/Pro 免费模型及 CF 独立审核实测，并上线服务。可选事件通知尚待配置签名 Secret。

## 运行方式

- 浏览器只轮询当前页面数据。隐藏标签页暂停自动轮询，回来立即刷新，同一轮询器不会重叠请求。
- 接单详情运行中约 10 秒刷新一次，终态约 60 秒；大厅和“我的接单”约 30 秒；catalog 与执行器列表约 5 分钟。钱包及平台配置低频刷新，操作后主动刷新。
- coordinator 有到期命令时约 1.5 秒检查；等待外部任务约 15 秒，无任务约 60 秒。截止时间会提前唤醒；清理改为每小时一次。QuickNode 通知可立即唤醒，定时链上补查仍保留。
- 静态资源直接由 Assets 服务，API、对象和 webhook 路径继续进入 Worker。不得漏掉原 `/api/*`、`/workspace/*`、`/bridge/*` 兼容入口。
- OpenRouter 只承担研究生成；引文审核和整体交付审核仍用 Cloudflare GPT-OSS 120B。Transfer 执行与验收都是 RPC 复算，不调用模型。

## 由用户最后填写的敏感配置

在自己的 Cloudflare Worker → Settings → Variables and Secrets 中添加为 **Secret**，不要写进 Wrangler vars、前端配置、聊天或 Git：

| 名称 | 内容 | 必需性 |
| --- | --- | --- |
| `QUICKNODE_RPC_URL` | Monad Testnet endpoint 完整 HTTPS URL，包含路径中的访问凭证 | QuickNode RPC 必需 |
| `OPENROUTER_API_KEY` | 项目专用 OpenRouter API Key | 免费生成必需 |
| `QUICKNODE_WEBHOOK_SECRET` | QuickNode Stream/Webhook 的 HMAC security token | 事件通知必需，RPC 单独可用 |

也可在仓库根目录运行交互命令，再按提示粘贴值，不将值作为命令参数：

```sh
npx wrangler@4.135.0 secret put QUICKNODE_RPC_URL --config apps/object-store/wrangler.local.jsonc
npx wrangler@4.135.0 secret put OPENROUTER_API_KEY --config apps/object-store/wrangler.local.jsonc
npx wrangler@4.135.0 secret put QUICKNODE_WEBHOOK_SECRET --config apps/object-store/wrangler.local.jsonc
```

不需要 QuickNode 管理 API Key，不需要用户主钱包私钥，不需要更换既有平台 signer。RPC 地址只在服务端使用；公开 `/platform/config` 仅报告 provider 名称，不返回私有 URL。错误日志不输出 viem 原始异常中的 RPC URL。

## 非敏感设置与上线顺序

`wrangler.jsonc` 是公开模板；已有部署继续使用自己的 `wrangler.local.jsonc`，不要覆盖账户、D1、合约或赞助参数。把本次模板的 `assets.run_worker_first` 路由数组同步到本地配置，并在 vars 中设置：

```json
{
  "PLATFORM_GENERATION_PROVIDER": "openrouter",
  "OPENROUTER_FREE_MODELS": "nex-agi/nex-n2.5-mini:free,nex-agi/nex-n2.5-pro:free"
}
```

以上两个候选在 2026-09-20 已完成云端中文研究生成、JSON 格式和独立引文/整体审核实测。最初的 DeepSeek、Gemma、NVIDIA 免费候选分别出现 503、429 或无匹配 endpoint，未保留在最终白名单。若当日 provider 不满足隐私/格式策略，允许失败，不自动放宽。旧部署需要显式切换生成 provider；当前维护者部署已选 OpenRouter，运行时失败不会切回 CF。

先在没有在途任务的窗口配置 Secrets，然后应用追加表、构建、部署：

```sh
npx wrangler@4.135.0 whoami
npx wrangler@4.135.0 d1 execute YOUR_DATABASE_NAME --remote --config apps/object-store/wrangler.local.jsonc --file apps/object-store/platform-schema.sql
pnpm check
npx wrangler@4.135.0 deploy --config apps/object-store/wrangler.local.jsonc
```

Schema 追加统一模型预算、调用记录及 webhook 去重表，不删除原任务。新代码查询这些表，必须先迁移再部署。`secret put` 会更新线上 Worker 环境，因此应在约定上线窗口执行；不要先切生成 provider 再寻找密钥。

## QuickNode 事件通知

在 QuickNode 选择 **Monad Testnet（10143）** 的 Streams 或支持相同 HMAC 格式的 Webhook：

- 只推送当前 TaskManager 合约的相关日志，不推送整条链的全部区块。
- 接收地址：`https://YOUR_PLATFORM_ORIGIN/webhooks/quicknode`。
- 启用 HMAC 签名，security token 与 `QUICKNODE_WEBHOOK_SECRET` 一致。
- **关闭压缩**，发送原始 UTF-8 JSON。当前端点拒绝 gzip；消息上限 256 KiB。
- 校验 `X-QN-Nonce`、`X-QN-Timestamp`、`X-QN-Signature`；签名为 HMAC-SHA256(token, nonce + timestamp + 原始正文)。timestamp 支持 Unix 秒/毫秒，允许 5 分钟时差。

通知仅是唤醒提示，不直接改变任务状态、插入结算事件或请求签名。服务继续从 RPC finalized 区块核验 TaskManager 日志并使用原游标去重；通知缺失时仍有定时补查。网络重试不会因提前写去重标记而丢失唤醒。

成功返回 204；缺失配置/服务不可用返回 503；签名、时效或正文无效返回 401。没有 Origin 的服务端投递允许进入此专用端点，普通平台写 API 的 Origin 校验不变。

## 免费模型限制

仅允许 1–3 个显式 `厂商/模型:free` ID，按列表顺序尝试；禁止付费 ID、`openrouter/auto`、随机 free router、付费插件或隐式模型列表。每次执行查询公开目录，确认所有报价字段为零且支持 JSON 格式，再发起请求。

请求携带 `provider.max_price` 的 prompt、completion、request、image 全部为 0，`data_collection: deny`、`require_parameters: true`、空 plugins。零价格或所需能力不可用就失败，不回退付费版本。返回模型身份或费用违反策略时立即停止，不继续 fallback。

每个候选最多一次调用，单次 30 秒，整体模型调用 110 秒，并受更短的原任务 lease/停止信号约束。取消后不会返回迟到结果或开启下一个候选。鉴权/额度错误不会反复尝试所有模型。无法使用任何候选时保留原任务恢复路径，不提交虚构结果。

所有平台生成入口共用每日 40 次应用预算（按 provider 计）；CF 两类审核共享独立每日 100 次预算，生成不能消耗审核预留。OpenRouter 额外限制每分钟 18 次；这是平台自己的上限，不是提供商的额度保证。每日计数按 UTC。Provider 限流仍可能更严格，失败/fallback 也消耗尝试次数。

## 用量与验收

统一记录 provider、模型、生成/引文审核/整体审核阶段、task/attempt、成功/失败/中断、返回的 input/output tokens。没有返回 tokens 的请求保留未知，不推算 Neurons 或美元账单。记录保留 30 天，不含 API Key、Cookie、任务正文、来源正文或模型输出。

接单详情的“生成与审核用量”分阶段显示；`GET /platform/model-usage` 需钱包会话，只返回当前用户今日聚合。历史任务没有新用量记录时不伪造数据。原托管“生成请求尝试”计数仍只表示执行侧。

真实上线前至少确认：

1. 私有 RPC `eth_chainId` 为 10143，能查询 finalized 区块、receipt 及 TaskManager 历史日志；公开 API 和浏览器网络不泄露 endpoint。
2. 每个白名单模型分别验证中文、严格 JSON、来源引用；设置故障条件验证免费 fallback，没有 CF 或付费生成调用。
3. 新研究任务完成生成、两类 CF 审核、支付并记账；换模型不能把语义正确性当作已验证。
4. 真实 QuickNode 通知返回 204，重复通知不重复交易；关通知后补查仍推进任务；所有步骤记录 task/attempt/hash。
5. 静态首页、下载文件及原团队工作区可访问，切页及时刷新，隐藏页请求停止，回到页面恢复。

参考：[OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)、[免费额度](https://openrouter.ai/docs/api_reference/limits)、[QuickNode 签名格式](https://www.quicknode.com/guides/quicknode-products/streams/validating-incoming-streams-webhook-messages)、[CF 静态资源计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)。
