# Mera / 私有交付 / ERC-8004 / MPP 验证记录

日期：2026-09-21。本地实现已发布到 M6 正式产品环境（Monad Testnet），随后按用户授权启用真实身份和 MPP 付款。没有领取或发放用户测试币；真实工具采购及专用测试任务的结果见下方新增验收。

## 自动检查

- `pnpm check`：构建、生成物一致性、workspace/root 类型检查、28 个 Foundry 测试、96 个 Node 测试通过。
- 最后对私有交付与 MPP 金额展示使用完整 USDC 精度，并重新通过 Explorer build/typecheck。
- `wrangler@4.136.0 deploy --dry-run`：Worker 打包通过；约 2.3 MiB、gzip 582 KiB。不代表已发布。
- `git diff --check` 通过。

## M6 正式部署

- 固定原 M6 自定义域名，公开配置返回 `environment=production`、正式入口和该域名的 Passkey rpId。
- 已备份 D1、追加 schema、添加 ToolPayments DO，并部署平台及三个独立 judge；保留原合约、数据、服务绑定与全部既有 Secrets。
- 已设置稳定的 `DELIVERY_REVIEW_KEY`，公开配置返回审核公钥；页面私有交付选项可用。
- 正式域名健康接口 200；三个 judge ready，未授权评估均 401；下载客户端与公布的 SHA-256 一致，两份指南返回 200。旧站与受保护模型网关仍可用。
- 浏览器已检查 Mera 登录对话框及 390px 页面，无横向溢出。没有用模拟认证器替代真实用户在正式站点创建 Passkey。
- 首次部署时 ERC-8004 和 MPP 未启用；后续授权启用与公网验收见下方记录。
- 上线检查修复了既有历史任务的恢复问题：finalized 任务已由其他路径结算、旧 quorum 交易没有回执时，保留原交易日志并停止该任务的后台处理，不重发交易、不伪造裁判付款。扩展 `platform-quorum-e2e.test.ts` 验证 Owner 结算、缺失回执、原 nonce 不变与恢复后健康状态；线上 coordinator 已恢复 ready。

## 新增证据

| 检查 | 实际覆盖 |
| --- | --- |
| `mera-account.test.ts` | 实际 Mera SDK + 模拟 PRF 认证器；创建/恢复相同地址、EIP-191、现有 EIP-712 授权、7702 authorization、会话结束拒绝签名、不同任务派生不同钥匙 |
| `private-delivery.test.ts` | 错误钥匙、上下文替换、内容和密文篡改拒绝；用户与审核者核对同一内容；公开结果和持久 checkpoint 无报告明文 |
| `private-platform-e2e.test.ts` | 本地 Monad EVM；Mera signer 实际创建 Vault、批准/存入/授权；平台执行、加密交付、审核、最终结算和用户端解密 |
| `mpp-policy.test.ts` | 链、币种、收款方、价格、期限、receipt 校验；跨任务/attempt/并发预算限额 |
| `mpp-e2e.test.ts` | 实际 ERC-20 付费、真实 MPP SDK challenge/credential/receipt；响应丢失与 actor 重启后只付一次；防止抢兑公开交易 hash；独立复算、加密提交、最终任务全额奖励不被工具费扣减 |
| 浏览器界面 | 桌面及 390px 手机领币指引；正确官方链接、地址复制入口；Mera 登录对话框及 Escape；模拟 PRF 解锁、浏览器存储无报告明文、刷新重新锁定及任务深链接恢复 |

本地链使用 DemoUSDC 与明确标注的 ERC-8004 ABI fixture；它们不代表 Circle Testnet USDC 或真实 registry 已实测。浏览器 PRF 替身只用于验证界面和 SDK 路径，没有创建用户的真实 Passkey。

## 尚未完成

- 不同密码管理器兼容性与跨设备恢复（用户已确认其设备上 Passkey 创建成功）。
- 固定生产 hostname 下的真实 Mera Testnet 充值、提现和授权。
- 独立密码学/生产安全审计。

前端构建仍有大 chunk 警告；当前构建可用，没有将其当作验证失败或隐藏。

配置与边界见 [Mera 运行说明](MERA-ACCOUNTS.md) 和 [ERC-8004/MPP](ERC8004-MPP-INTEGRATION.md)。信誉写回未在本轮实现。

## 新账户充值引导修复

- 创建成功后进入预算页；余额驱动领币/充值/返回任务按钮，未充值时首页持续提示，刷新可恢复。
- 本地浏览器使用实际 Mera SDK 与模拟 PRF 认证器、模拟账户余额验证创建跳转、零余额、测试币到账、预算到账、焦点跳转和中英文；390px 无横向溢出。未在正式站点使用模拟认证器创建账户或广播交易。
- 隐藏旧版入口与迁移提示，登录弹窗增加 Mera 署名，页脚增加版权和技术提供方链接。
- Explorer 构建、i18n 两项回归与 diff 检查通过；仅 UI 变更不重复运行无关合约测试。

## 真实 ERC-8004 / MPP 启用验收

- 核对官方 Monad Testnet Identity Registry 的链、字节码、名称后，真实注册执行器和自营工具提供方，并通过 EIP-712 绑定实际执行器钱包。注册时一次 RPC 断连通过相同 journal/交易 hash 恢复，没有重复划款或注册。
- 独立工具 Worker/D1 上线，仅暴露健康、Agent 资料与付费统计服务；公网返回实际 `monad/charge` 402 报价，接收方与链上 agentWallet 一致。
- 正式平台成功完成一笔真实分析任务，payer nonce 只增加 1；平台付工具费 0.001 test USDC，执行器收到完整 0.01 test USDC 奖励，requester Vault 仅减少奖励金额。结果经过重新查询 Transfer 的独立复算。
- 公共产物中的执行器身份快照、提供方身份、采购证据 hash、实际 Transfer 与任务 resultHash 一致。正式自定义域名下的两个凭证链接已校验可映射到本站内容寻址对象。
- 将已支付交易附上有效付款方签名用于另一个订单，服务返回 `409 PAYMENT_ALREADY_USED`，没有新转账，payer nonce/余额不变。
- MPP 本地 3 项回归（包括真实本地链、响应丢失和重启恢复）、Explorer build/i18n、类型检查通过。工具是 Worknet 自营，不声称已经接通第三方运营的提供商；也不将软件测试 requester 冒充为真实 Mera 用户端资金验收。
- 证据与配置保存在 `.runtime/m6/protocol/`，平台和服务的链上 signer/数据库均保留持久恢复记录。

## 外部 Agent 与可安装 Skill

- 外部执行器新增固定任务输入的 MPP 采购 API；外层配对鉴权与内层付款 actor 均核验 executor、owner、run、attempt、specHash、实际领取与有效期。报价后撤销、错执行器、未领取、输入改价和伪造 artifacts 均被拒绝。
- CLI `tool` / `run --paid-tool` / `watch --paid-tool` 与 MCP `taker_purchase_transfers` 已接通；默认本地分析保持只读。测试覆盖并发付一次、撤销竞态、上传响应丢失恢复以及付费/本地缓存隔离。完整检查为 28 Foundry + 98 Node；最后相关 10 项复测及构建/类型检查通过。
- 公网开放任务通过真实 stdio MCP 采购、CLI 重复查询并上传；首次等待 finality 后使用同一 runId 恢复，payer nonce 仅增加 1。实际工具费 0.001 test USDC，接单者完整获得 0.01 test USDC 奖励，requester Vault 只减少奖励。未注册的外部 worker 没有冒用平台 Agent 身份。测试后撤销了专用执行器凭证。
- 公网使用既有专用软件测试身份模拟 Owner 确认，不是新增产品钱包模式，也不声称测过用户真实设备上的 Passkey 完整接单流程。
- 可下载 Skill 内置独立 CLI、stdio MCP、平台公开 origin 与校验码。验证了解包、安装、拒绝覆盖非托管目录、受控更新和客户端启动；本机 Codex 已安装。界面增加 Skill 下载入口，390px 无横向溢出。
- 此前旧版配对只保存执行器凭证，仍需逐单签名。自主账户升级见下节；账户控制和恢复继续使用 Mera Passkey。

## 自主账户与持续执行授权（2026-09-22）

- `init`、网页首次确认和 `take` 接通；Skill 自带 CLI 与 14 项 stdio MCP 工具。Mera 控制收款账户，本地执行密钥仅获领取/提交权限，gas 与收款地址分别展示。
- 本地 Monad EVM 验证首次 7702 激活、主账户无 MON 的自主领取/提交、重试不重复花 gas、奖励归属，以及错误签名者、转账、任意方法、过期和链上撤销均被拒绝。调用余额从 200 变为 198；续授权保留执行地址和密钥、恢复同一待批准 ID，未再次批准前不可工作。20 项相关回归通过，最后受影响的接单与 i18n 测试再次通过。
- 公网任务 #6 完成首次激活、领取、提交、独立复算和 0.01 test USDC 结算。网络断连后恢复同一 run，执行地址 nonce 只增加 2；测试后链上和 API 权限均已撤销。
- 领取：`0x0e5ab52e16f2805677ca503deaf390585ea71bb020b4c3f6cff288a4ef36a987`；提交：`0x5d9d5ea0c3b0494e759ca42ea6b3ac33aa6227446317f2d421823c69328e35a4`；结算：`0x91beb7287f52014b2093776700f751b7c908331b0a2380b5c2d6e58565162f3e`；链上撤销：`0xaa648d26b07c5efde0514232697c3db6d660be0e3dc07fbf8f53196971ea0a20`。
- 公网验收的初始授权由已有专用软件测试身份代签，未使用虚拟认证器，不代表真人 Passkey 设备验收。首次设置的 390px 布局无横向溢出，未登录时授权按钮禁用。
