# Mera 账户、私有交付与测试币

状态：已发布到 M6 正式产品环境（Monad Testnet）。Mera 账户入口、自行领币指引和私有交付已启用，用户已确认真实 Passkey 创建成功；跨设备恢复与完整资金流程仍待验收。ERC-8004 身份与平台限额 MPP 采购已单独配置并通过公网端到端，见 [运行说明](ERC8004-MPP-INTEGRATION.md)。

## 用户流程

主平台通过 Mera 通行密钥创建、登录与恢复 EVM 账户。没有用户私钥托管服务，不显示或要求助记词，不需要浏览器钱包插件。现有 Vault、任务、审核和奖励结算保持原有协议。

创建账户后自动进入“预算与账户”，展示创建账户、领取测试币、充值任务预算三步。引导根据余额提供“去领取测试币”“去充值任务预算”或返回任务的下一步；允许先准备草稿。尚未充值的登录用户回到任务首页时仍显示预算提醒，刷新后也会根据实际余额恢复。平台导航不展示旧版任务/预算、原团队工作区或迁移提示，历史兼容 URL 不作账户或数据迁移。

登录弹窗标注 Mera 账户技术支持，页脚展示 Worknet 版权和实际使用的技术提供方链接；这些署名不表示第三方对产品作出官方背书。

新用户在“预算与账户”复制自己的账户地址，打开 [Monad Faucet](https://faucet.monad.xyz/) 领取测试 MON，再打开 [Circle Faucet](https://faucet.circle.com/) 选择 USDC / Monad Testnet 并粘贴同一地址领取测试 USDC。返回平台刷新余额后，用户确认将 USDC 存入自己的 Vault 并设置任务授权。平台不提供领币池、代领接口或新用户赠币；外部网站的验证码与限流由用户自行处理。测试资产没有真实货币价值。

Mera 账户的普通交易由用户账户支付 gas。平台后台操作与可选 MPP 工具采购使用已有的独立服务账户和配置额度，不把用户主账户密钥传入执行器。新接单者可沿用钱包模式的任务领取和提交，界面中的账户签名由 Mera 完成。

旧浏览器钱包账户可通过 `/?account=external` 访问同一平台与原有资产；这是独立的兼容入口，不会把旧钱包地址或 Vault 自动迁移到新 Passkey。`/#legacy` 原团队工作区仍保留。

## 账户派生与恢复约定

- 固定实际部署域名后再创建正式使用的 Passkey。`rpId` 为站点 hostname；预览域名、localhost 和正式域名不是同一个账户域。
- 钱包 PRF salt 为 SHA-256(`worknet-mera-account/1`)。通过 HKDF-SHA256 的 `worknet-mera-secp256k1/1:N` 域派生 secp256k1 私钥；N 从 0 开始，选择第一个有效标量。版本与算法必须保留，不能以升级名义更改后造成地址变化。
- 任务 salt 为规范 JSON `{namespace:"worknet-delivery/1",rpId,owner:lowercaseAddress,goalId}` 的 SHA-256。以该 salt 调用 Mera PRF，再通过独立 HKDF 域 `worknet-delivery-x25519/1` 派生 X25519 解密钥匙。
- 每个任务 salt 是公开元数据，保存在 TaskSpec 中。只要原 Passkey 在当前域名可访问、任务元数据和密文仍存在，就能在另一台支持的设备重建同一把钥匙。
- 浏览器仅持久保存 credential ID、账户地址、rpId 和派生版本。PRF 输出、账户私钥和交付私钥不写入本地存储或后端。用户交易日志保存的是已签名的公开交易字节，不是签名私钥。
- signing session 最长 5 分钟，退出与 pagehide 时结束；账户登录 Cookie 不等于仍持有签名能力。交付解锁内容只存在当前页面内存，锁定、刷新或离开页面后需重新解锁。

**恢复边界**：需要原 Passkey（通常由用户的密码管理器同步）。另一把新 Passkey 不会恢复旧账户。域名丢失、原 Passkey 不可访问或密文/公开元数据丢失时，本实现不能凭邮箱找回。发布前必须实测选定的设备、密码管理器、跨设备同步和固定域名。本次自动测试使用模拟 PRF 认证器，不替代真实设备验证。

## 私有交付

设置 Worker secret `DELIVERY_REVIEW_KEY` 为专用随机 32 字节小写 hex X25519 key（`0x` 前缀）。它是审核服务的操作密钥，不是任何用户的账户或任务私钥。后端只公开对应公钥；前端为每个私有任务重建用户任务钥匙并提交公钥。

未配置审核密钥时，旧公开交付路径可用，UI 明确显示本次为公开交付，不会把明文标成私有。正常启用后，创建计划默认勾选私有交付，发布者可明确取消。

加密封装为临时 X25519、HKDF-SHA256 和 AES-256-GCM。关联数据绑定版本、收件公钥、临时公钥、specHash、taskId、attempt 和 worker。报告正文与随机 opening nonce 一同加密；公开 manifest 保存加盐内容承诺和用户密文。标准 TaskSpec/result schema 的既有 fixture 保持兼容。

获授权的审核服务收到独立加密的 opening 副本。它验证内容承诺，并通过 opening nonce 重建发送方临时密钥，复验用户密文确实包含同一份内容，之后才进行原有质量审核。Judge 签名仍绑定**公开加密 manifest 的 resultHash**。客户的解密私钥不会交给 Judge。

托管执行的持久 checkpoint、审核副本使用审核公钥加密；公开对象、platform_goals、platform_runs 中的结果为用户密文。公开审核文字使用不含报告片段的通用说明。任务描述、输入来源、领取地址、支付与裁判结果仍公开。

这不是“平台从未见过内容”：托管执行器、模型和授权审核服务会处理明文。审核恢复副本目前加密保留以支持重试；持有服务审核密钥的一方可以解密该副本。修改审核密钥前必须处理所有依赖旧密钥的待办，当前没有自动 key-ring 轮换。加密实现经过功能与篡改测试，尚未进行独立密码学审计。

## Mera bounty 演示

1. 完整账户层：无钱包插件创建 Passkey 账户；复制地址自行领币；存入预算、发单、查看结算；退出后用原 Passkey 恢复相同地址。
2. 非钱包 PRF 用途：创建两个私有任务，展示不同任务公钥；使用原 Passkey 解锁报告；刷新后重新锁定；在可访问同一 Passkey 的另一台设备重建钥匙。任务 A 的私钥不能解密 B。
3. 如启用 ERC-8004/MPP，在原任务详情中展开身份快照和平台承担的工具采购记录。付款与报告质量仍独立验证。

## 本地自主 Agent

自主 Agent 通过 Skill 的 `init` 发起首次设置。用户用 Mera 创建或选择收款账户并授权后，本地执行密钥可自主领取和提交。链上授权绑定 Testnet、当前 TaskManager、领取/提交方法、零 value、7 天和 200 次调用。执行密钥在用户机器以 0600 保存，平台不保存它；Mera 主私钥和 PRF 输出仍不持久化。

用户给 `gasAddress` 补充 test MON，首次 7702 激活也由它支付 gas；奖励进入 `rewardAddress`（Mera 账户）。两地址在网页和 CLI 明确区分，不使用平台领币池。授权用完或到期后需重新确认。Owner 可停止平台访问并发送链上撤销交易；撤销需 Mera 收款账户本身有少量 MON，确认前不能把 API 撤销当成链上权限已失效。

## 发布前验证

执行 `pnpm check`，再用固定 HTTPS 域名进行真实 Passkey 创建/恢复、Mera 签名 Testnet 充值、资金不足恢复、私有研究/统计任务和跨设备解锁。用户签名需要真实设备参与，模拟认证器测试不得写成已完成真人验证。

依赖固定为 `@category-labs/mera@0.2.0`。官方说明：[入门](https://mera.category.xyz/getting-started/)、[PRF salt](https://mera.category.xyz/reference/get-passkey-prf-output/)、[viem](https://mera.category.xyz/reference/to-viem-account/)、[安全模型](https://mera.category.xyz/concepts/security-model/)。
