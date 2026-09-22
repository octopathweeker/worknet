# ERC-8004 与 MPP 产品内集成

状态：已在 M6 正式产品环境（Monad Testnet）启用真实 ERC-8004 身份和 MPP 工具采购，并完成公网付款、独立复算及任务奖励结算验证。身份、部署和交易证据保存在本机忽略目录 `.runtime/m6/protocol/`。

## 当前运行配置

- 平台执行器与转账分析工具服务拥有两个分别注册、核验钱包绑定的真实 Agent 身份。
- 工具服务由 Worknet 独立部署和运营，使用自己的 Worker、D1 和收款地址；这是自营付费工具，不宣称是第三方运营商。服务不持有用户、执行器或平台付款账户的签名私钥。
- 价格为每次 0.001 test USDC；平台上限为每任务 0.002、每天 0.01 test USDC，单次工具支付 gas 上限为 0.05 test MON。该 gas 上限依据当前测试网估算设置，示例的 0.001 MON 不足以覆盖真实转账。
- 专用 payer 初始运营余额为 0.02 test USDC 和 0.15 test MON，不自动补充；资金不足时需检查原交易再补充，不能删除支付日志。平台用户仍自行通过链接领取测试币，不存在用户赠币池。
- 一笔公网分析任务已验证：工具支付为 0.001 test USDC，独立复算通过，执行器完整收到 0.01 test USDC 奖励，用户 Vault 仅扣任务奖励。
- 信誉写回尚未启用；未注册的普通接单用户不会被冒用平台身份。

## 维护与恢复

`scripts/enable-protocols.ts` 默认为只读预检，`--broadcast` 才执行已经授权的初始运营划款、身份注册与钱包绑定。角色密钥和服务密钥保存在 `.runtime/m6/protocol/`，所有链上操作用持久 journal 恢复；不得删除目录来重试。身份绑定签名有 5 分钟有效期，未决绑定须核对回执与原 nonce 后再处理。

服务端配置是 `.runtime/m6/protocol/wrangler.jsonc` 和 `service-secrets.json`；平台端配置为 `.runtime/m6/protocol-secrets.json`。常规 `pnpm deploy:production` 会先更新该工具服务、再更新裁判与平台，并保留已有 Secrets。工具服务入口只提供健康、Agent 资料与付费工具路由，不开放平台登录或用户账户 API。

`scripts/verify-protocols.ts` 使用既有的专用测试 requester 预算、固定任务意图，执行一笔最小任务并核对两个付款账本。重跑恢复同一任务，不自动创建新的测试预算或领取测试币。验收会检查交易 nonce、实际 Transfer、身份快照、产物 hash、独立复算、完整任务奖励和用户预算差额。

## M6 启用顺序

1. **选择正确网络的注册表。** 官方 [合约部署表](https://github.com/erc-8004/erc-8004-contracts#monad-testnet) 列出的 Monad Testnet Identity Registry 为 `0x8004A818BFB912233c491871b3d84c89A494BD9e`，链 ID 为 10143。Monad 指南列出的 `0x8004A169…` 是主网地址，不能直接用于本环境。启用前再次核对 finalized 字节码及 `ownerOf`、`tokenURI`、`getAgentWallet`。
2. **注册实际执行 Agent。** 发布 HTTPS Agent 资料，由身份所有者调用 `register(agentURI)`，记录返回的 agentId；核验 agentWallet 绑定到实际执行地址。已有注册身份可以直接复用。把 registry 和真实 worker→agentId 映射写入 `ERC8004_CONFIG`。此步骤启用身份快照，不等于已启用信誉写回或付费采购。
3. **准备付费工具提供方。** 提供方注册自己的身份，agentURI 指向 `/services/agent.json`，资料声明 `/services/transfers` 的 MPP endpoint，agentWallet 对应实际收款地址。可单独部署本仓库服务，也可对接符合当前转账统计输入/输出约定的提供方；不是任意 MPP URL 都能替换。自建服务需配置下文的 `MPP_SERVICE_CONFIG` 和 `MPP_SERVICE_SECRET`。
4. **准备平台工具费账户。** 使用独立于用户、operator、worker、sponsor 的专用 payer，并为它准备少量 test MON（手续费）与 test USDC（工具费）；它是平台运营账户，不是新用户领币池。其私钥仅写入 `MPP_PAYER_KEY` Secret，不经前端或用户 Passkey。未提供该账户及资金时保持采购关闭。
5. **配置明确额度并发布。** 设置 `MPP_TOOL_CONFIG` 的提供方身份、endpoint、每次/每任务/每天 USDC 上限及每次 gas 上限。下面示例为单次 0.001、每任务 0.002、每天 0.01 test USDC，数值只是部署示例，不代表已获授权支出的额度。M6 已有 TOOL_PAYMENTS binding 和数据库表，无需再次部署任务合约。
6. **验证一笔最小采购。** 核对 402 challenge、链和币种、收款绑定、平台支付交易、receipt 与独立复算，再验证重试不重复支付。任务奖励应保持原数额，详情另列平台工具费。保存真实交易证据后才能宣称公网 MPP 已接通。

将确定的配置放入本机忽略目录的专用 Secret JSON（权限 0600，包含 `ERC8004_CONFIG`、`MPP_TOOL_CONFIG`、`MPP_PAYER_KEY`，JSON 配置字段的值为序列化字符串），不要改写用户账户或原角色私钥。部署命令：

```sh
pnpm dlx wrangler@4.136.0 whoami
pnpm dlx wrangler@4.136.0 secret bulk .runtime/m6/protocol-secrets.json --config .runtime/m6/wrangler.jsonc
pnpm deploy:production
```

`secret bulk` 导入后即可影响服务，必须先完成身份、提供方、资金和额度核对；不要先写入虚构 agentId 或示例 endpoint。关闭采购时移除 `MPP_TOOL_CONFIG`，保留支付日志和专用 payer 以便核对未决交易。

## 产品约束

保持发布、充值、接单、托管执行、交付、独立审核和收款的主流程。工具费由平台在明确限额内承担，不扣用户 Vault、不减少任务约定奖励，也不要求接单者准备第二个钱包。当前 TaskManager 的托管、验收、裁判分账与超时规则保持不变。

ERC-8004 是身份与可追溯反馈层；MPP 是执行阶段购买能力的支付层；Worknet 继续负责任务合同与最终结算。协议能力不是新的产品主导航。

## 身份归属

- 平台执行器可配置已注册的 ERC-8004 身份，核对 registry 的实际代码、目标链与 agentWallet。
- 开放接单的链上 worker 是用户钱包，不能把平台托管模板的身份冒充为用户身份。用户身份与平台提供的执行服务身份分别记录。
- 付费工具服务必须具有已配置的注册表身份；付款收款地址必须与该身份核验时的 agentWallet 一致。
- 记录核验区块、区块 hash、身份 owner、agentWallet 与 agentURI。既有结果保留历史快照；新调用重新检查钱包绑定，身份转移或清空钱包不能沿用旧缓存。
- 身份证明不代替交付质量检查；未注册的普通接单者仍能走原有任务流程。

## 支付与执行

第一条接入路径是现有的 USDC Transfer 区间统计。托管执行可通过 MPP 购买同一输入、同一输出格式的计算服务；验收端仍直接读取链上数据独立复算。付费服务返回结果不直接触发放款。

支付授权由独立平台工具支付模块持有。模型与执行器不接触支付私钥，只能提交与已领取 task/attempt/specHash 绑定的受限工具请求。服务地址、链、代币、收款者、金额、支付方式、有效期以及任务和全局累计额度均在签名前验证。

使用显式 MPP 客户端，禁用全局 fetch patch。先持久记录预算预留与签名凭证，再提交付款；不确定状态保留额度并复用同一支付意图，不以超时为由生成第二笔付款。跨实例共享防重放和幂等记录。付费后计算失败、取消或审核拒绝，已发生工具费用仍由平台承担。

平台费用分开记录：任务奖励、工具费、工具支付 gas、原有任务交易 gas。未知费用不写零，平台赞助不写免费。

## 证据和界面

采购记录关联 chain/manager/task/attempt、服务方 agentRef、身份快照、请求 hash、付款凭证引用、实际转账、结果 hash 和支付状态。签名授权与密钥不出现在公开 API、产物、日志或 UI。

现有任务详情与运行记录增加折叠的“身份与服务凭证”：查看身份、已核验钱包、平台承担的工具费、支付交易与结果来源。充值页、发布表单、接单步骤保持原流程。

## 信誉

信誉写回与结算解耦。只有匹配具体 task/attempt/resultHash 的实际裁决或验收证据才生成反馈；审核超时、取消、技术不可验证与质量验收分别表述。由真实 requester 或明确标注的观察者提交，不能把平台观察者伪装成买方；遵守 ERC-8004 对 owner/operator 自评的限制。链上提交需有相应账户授权，失败可单独恢复，不阻塞任务结算。

## 验收

1. 关闭新配置时，原有平台回归保持通过。
2. 身份链、注册表、钱包、历史快照和转移后失效检查。
3. 真实 MPP challenge/credential/receipt 往返与 ERC-20 转账验证。
4. 超额、错误链/币种/收款者、重定向、并发、重放、重启与响应丢失不会扩大付款。
5. 付费工具的正确结果通过独立复算；错误结果被拒绝，付款本身不算质量证据。
6. 任务取消、lease/授权过期后不发起新支付；已签名或已支付记录保留并可核对。
7. 多用户记录隔离；公开产物无签名授权或秘密配置。
8. Testnet 实测与部署状态分别记录；本地模拟测试不替代公网链上证据。

## 官方依据

- https://eips.ethereum.org/EIPS/eip-8004
- https://docs.monad.xyz/guides/erc-8004
- https://docs.monad.xyz/reference/mpp/overview
- https://docs.monad.xyz/reference/mpp/api

ERC-8004 的目标注册表部署与 ABI、MPP SDK 的实际版本和代币授权支持必须在启用前核对，不凭示例地址或同名接口推断可用。

## 当前启用方式

依赖固定为 `@monad-crypto/mpp@0.0.3`、`mppx@0.10.1`。当前走 push 模式，避免假定 SDK 内置的 ERC-3009 token 列表覆盖测试网 USDC。平台支付账户必须独立于 sponsor、operator 和 worker。

Worker 配置：

- `ERC8004_CONFIG`：JSON `{ "registry": "<verified address>", "workers": { "<lowercase worker address>": { "chainId": "10143", "registry": "<same registry>", "agentId": "<decimal string>" } } }`。只为核验通过的实际 worker 附加身份，不把托管服务模板的身份冒充为接单用户。
- `MPP_TOOL_CONFIG`：JSON `{ "endpoint": "https://provider.example/services/transfers", "provider": { "chainId": "10143", "registry": "<verified registry>", "agentId": "1" }, "maxPerCall": "1000", "maxPerTask": "2000", "maxPerDay": "10000", "maxGasWei": "1000000000000000" }`。金额均为 base units，例中单次上限是 0.001 USDC；每天另有最多 100 个支付预留，限制 gas 支出次数。
- `MPP_PAYER_KEY`：平台工具支付专用 secret。不得使用用户 Passkey 派生密钥。
- `TOOL_PAYMENTS`：新的 Durable Object binding 和 `tool-payments-v1` migration。需同步到本机私有 wrangler 配置。

工具提供方可独立部署本仓库中的 `/services/transfers` 与 `/services/agent.json`，并设置 `MPP_SERVICE_CONFIG` 为 `{ "agent": { "chainId":"10143", "registry":"<verified registry>", "agentId":"1" }, "recipient":"<bound agentWallet>", "priceBaseUnits":"1000", "origin":"https://provider.example" }`，另设置至少 32 字符的 `MPP_SERVICE_SECRET`。其链上 agentURI 必须指向该 origin 的 `/services/agent.json`。真实身份需由其所有者注册；代码不硬编码或伪造 registry 部署。

调用方验证链上钱包、同源注册资料中的 MPP endpoint、chain/currency/recipient/price/expiry。平台签名交易在广播前保存在 Durable Object 中；同一 task/attempt 固定一笔采购。服务端由 SDK 验证 MPP 凭证，再以数据库唯一交易 hash 原子绑定订单；相同订单/凭证恢复缓存，不把同一笔转账卖给另一个订单。

数据库更新：重新执行 `apps/object-store/platform-schema.sql`，新增的表均为 `CREATE TABLE IF NOT EXISTS`。旧任务没有采购配置时仍使用原执行路径。

不确定交易的预留额度不会自动释放。前一笔未确认时暂停分配新 nonce；已矿工确认的交易可在下一次调用时自动对账。若任务已结束且原交易未确认，需要运维核对并恢复原签名交易或明确处理其 nonce，不能删除 outbox 后再付一笔。

信誉写回仍属于后续独立能力，本次没有自动发布评分；当前完成的是 Identity 接入与采购证据链。

## 本地证据

- `tests/mpp-e2e.test.ts` 在本地 Monad EVM 上执行实际 ERC-20 转账，覆盖付款后响应丢失、actor 重启、并发重试、结果独立复算和身份钱包解绑。注册表是明确标注的 ABI fixture，不宣称测试了真实 ERC-8004 注册表部署。
- `tests/mpp-policy.test.ts` 覆盖错误链、收款方、币种、价格、期限、receipt 和并发预算预留。
- 这些测试不是公网付款记录，也没有为真实用户领取或发放测试币。

### Worknet 订单归属扩展

本仓库的服务端在标准 MPP hash 凭证之外要求 `x-worknet-payment-proof`。支付方对 `orderProofMessage(endpoint, idempotencyKey, canonicalInputHash, transactionHash, currency)` 返回的字符串做 EIP-191 签名。格式实现位于 `apps/object-store/src/mpp-policy.ts`，版本为 `worknet-mpp-order/1`，包含固定链 ID、完整 endpoint、订单 ID、输入 hash、交易 hash 和币种。客户端已自动发送该头。服务资料公开声明该扩展。

这是 Worknet 的附加订单绑定，不宣称是 MPP 标准字段。它防止旁观者仅凭公开转账 hash 和可伪造的 source DID 抢兑其他人的订单。签名不授予转账权限；改变订单、输入或 endpoint 后不能复用。第三方调用本服务需同时生成此证明；外部标准 MPP 服务可以忽略该附加头。

## 外部 Agent / CLI / MCP

已配对且被明确分配本轮任务的外部执行器，可用 `POST /platform/taker/runs/:runId/tools/transfers` 申请同一受限服务。外层 API 从数据库与链上 spec 构造输入，内层付款 actor 再次核验 executorId、approved/revoked/expiry、run/owner/attempt/lease；在报价与签名前后重新检查，撤销不会变成开放的代付权限。

客户端默认本地计算；选择 CLI `--paid-tool` 或 MCP `taker_purchase_transfers` 才申请平台采购。收到的 execution JSON 在原上传接口提交，由服务端按输出/provenance hash 绑定采购凭证。外部 worker 没有注册映射时不附加执行器身份，不冒用平台 Agent；工具提供方的真实身份始终在采购证据中。Mera 账户模型保持不变，Skill 和执行器只保存配对凭证。
