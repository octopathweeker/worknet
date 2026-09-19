# Monad 开发资源与接入清单

更新日期：2026-09-19。网络参数于 2026-09-18 核对；本次根据用户提供的完整 Metropolis Resources Agent 版本及公开一手文档补充。部署时再次核对网络、依赖和代币地址。

## 1. 比赛入口与核实范围

[Monad Hackathon Resources](https://hackathon.monad.xyz/resources)

上轮访问只看到登录入口；本轮用户已提供标明 Source 为该 URL 的完整 Agent 版资源正文。资源目录、四类赛道和赞助福利以这份用户提供的内容为依据；关键技术能力另查提供方官方文档。Chrome 标签页工具连接失败，原生窗口操作检测到用户窗口持续变化，未完成对登录页面的独立读取，不将其记为本次已浏览成功。

按资源目录，本项目建议主定位 **Trust, Identity & AI Infrastructure**，支付部分可辅助对应 Consumer Products & Payments。目录不是参赛规则；最终截止时间及其时区、允许的网络、具体奖项资格、外部代码使用规则、仓库公开要求、视频长度与提交格式仍需从比赛后台确认。

官方资源目录中标记 Monad Foundation 的是基金会发布资料，其他来自独立生态团队；被列入目录不等于所有服务均由 Monad 官方维护，也不代表服务可用性或经济机制已获背书。

## 2. 按本项目优先级整理

| 优先级 | 资源 | 在项目中的用途 |
| --- | --- | --- |
| P0 | [Monad 官方文档](https://docs.monad.xyz/) | 官方开发资料入口 |
| P0 | [Testnet 网络信息](https://docs.monad.xyz/developer-essentials/testnet) | chain ID、RPC、WebSocket、explorer、faucet |
| P0 | [Mainnet 网络信息](https://docs.monad.xyz/developer-essentials/network-information) | 读取主网公开数据或后续正式部署时使用 |
| P0 | [Deployment Summary](https://docs.monad.xyz/developer-essentials/summary) | 理解 EVM 差异、receipt/finality、工具兼容性 |
| P0 | [Foundry 工具指南](https://docs.monad.xyz/tooling-and-infra/toolkits/foundry) | 使用支持 Monad 执行规则的测试工具 |
| P0 | [Foundry 部署教程](https://docs.monad.xyz/guides/deploy-smart-contract/foundry) | 编译、Testnet 部署、keystore 操作 |
| P0 | [Foundry 合约验证](https://docs.monad.xyz/guides/verify-smart-contract/foundry) | 公布可检查的合约源码 |
| P0 | [Circle USDC 合约地址](https://developers.circle.com/stablecoins/usdc-contract-addresses) | 核对官方 USDC，不通过 token symbol 猜地址 |
| P0 | [Monad Faucet](https://faucet.monad.xyz/) | Owner、Requester signer、Worker 的测试 MON |
| P0 | [Circle Faucet](https://faucet.circle.com/) | 测试 USDC；获取方式见 Monad x402 教程 |
| P0 | [WebSocket Reference](https://docs.monad.xyz/reference/websockets) | TaskCreated / ResultSubmitted 事件监听 |
| P0 | [RPC Limits](https://docs.monad.xyz/reference/rpc-limits) | 设计分段 getLogs、限流和重试 |
| P1 | [Monad Developers](https://github.com/monad-developers) | 官方开发示例与模板入口 |
| P1 | [foundry-monad 模板](https://github.com/monad-developers/foundry-monad) | 合约开发起点；不要覆盖现有 docs |
| P1 | [Agentic Payments](https://docs.monad.xyz/tooling-and-infra/agentic-payments) | 解释项目与官方机器支付生态的关系 |
| P1 | [ERC-8004 on Monad](https://docs.monad.xyz/guides/erc-8004) / [规范](https://eips.ethereum.org/EIPS/eip-8004) | 可移植 Worker 身份；注册不代表交付质量 |
| P1 | [Trust8004](https://trust8004.xyz/) / [8004 Build 目录](https://www.8004.org/build) | 身份与反馈展示；API 契约和目标网络需实测 |
| P0 | [QuickNode Monad Quickstart](https://www.quicknode.com/docs/monad/quickstart) | 使用赞助 RPC 额度运行 SDK、Worker 与 reviewer |
| P0 | [Tenderly 支持网络](https://docs.tenderly.co/platform/supported-networks) | 开发期调试与模拟，接入时核对目标网络具体功能 |
| P1 | [Alchemy MCP](https://www.alchemy.com/docs/alchemy-mcp-server) | OAuth 接入，只选择 Worker 所需的读取工具 |
| P1 | [Zerion CLI / Skills](https://developers.zerion.io/build-with-ai/zerion-cli) | 可选钱包分析工具；签名/交易能力不自动开放 |
| P1 | [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview) / [Monad](https://envio.dev/chains/monad) | Explorer 事件索引的可替换实现 |
| P2 | [Mera Passkey 账户](https://docs.monad.xyz/guides/mera) | Owner onboarding 备选；不提供 Vault 花费限额 |
| P2 | [x402 集成教程](https://docs.monad.xyz/guides/x402) | 后续同步付费 API，独立于 TaskManager escrow |
| P2 | [MPP Overview](https://docs.monad.xyz/reference/mpp/overview) | `@monad-crypto/mpp` 的客户端与服务端支付接入 |
| P2 | [EIP-7702 on Monad](https://docs.monad.xyz/developer-essentials/eip-7702) | 后续替换/扩展 Requester account adapter |
| P2 | [Execution Events](https://docs.monad.xyz/execution-events/index) | 规模扩大后的低延迟数据接入 |

其中 faucet 和 explorer 是官方文档指向的使用入口；本次没有领币、连接钱包或执行部署，也没有验证各服务的运行时可用性。

## 3. 当前建议配置

### Monad Testnet：MVP 的结算网络

| 项 | 配置 |
| --- | --- |
| chainId | `10143` |
| 原生 gas token | `MON` |
| 公共 HTTP RPC | `https://testnet-rpc.monad.xyz` |
| 公共 WebSocket RPC | `wss://testnet-rpc.monad.xyz` |
| MonadVision | [testnet.monadvision.com](https://testnet.monadvision.com/) |
| Monadscan | [testnet.monadscan.com](https://testnet.monadscan.com/) |
| Circle 测试 USDC | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |

网络配置来源：[Monad Testnet](https://docs.monad.xyz/developer-essentials/testnet)。USDC 地址来源：[Circle 官方地址表](https://developers.circle.com/stablecoins/usdc-contract-addresses)。测试 token 没有真实美元价值。

### Monad Mainnet：可选的公开数据来源

| 项 | 配置 |
| --- | --- |
| chainId | `143` |
| 原生 gas token | `MON` |
| 公共 HTTP RPC | `https://rpc.monad.xyz` |
| MonadVision | [monadvision.com](https://monadvision.com/) |
| Monadscan | [monadscan.com](https://monadscan.com/) |
| Circle USDC | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` |

来源：[Monad Mainnet](https://docs.monad.xyz/developer-essentials/network-information)、[Circle 官方地址表](https://developers.circle.com/stablecoins/usdc-contract-addresses)。方案不要求现在使用主网资金。

部署 manifest 应包含 `chainId / taskManager / vault / settlementToken / tokenDecimals / deploymentBlock / abiVersion / deployedBytecodeHash`。启动时查询 `eth_chainId`，检查各地址有代码、token decimals 符合配置，再允许发交易。测试 USDC 按 6 decimals 处理，最终以链上查询核对。[Monad USDC 示例](https://docs.monad.xyz/guides/x402)

## 4. 对本方案有实际影响的 Monad 特点

| 官方事实或约束 | 实现上的处理 |
| --- | --- |
| 工具支持 EVM，但存在 Monad 执行/gas 差异 | Foundry 启用 `network = "monad"`，并 fork 目标网络或对齐活动 hardfork |
| receipt、Finalized、Verified 是不同阶段 | UI 显示确认阶段；Worker 和支付确认采用明确的 finality policy |
| 公共 RPC 有速率与批量限制 | getLogs 分段；退避重试；事件回补游标持久化 |
| Task 时间使用秒级 timestamp | 用 timestamp 比较 lease/review deadline，不用固定区块数代替秒数 |
| gas 计费按 gas limit 规则处理 | 通过模拟与估算给出合理余量，不随手设极大 gas limit |

来源：[部署概要](https://docs.monad.xyz/developer-essentials/summary)、[Foundry 指南](https://docs.monad.xyz/tooling-and-infra/toolkits/foundry)、[RPC Limits](https://docs.monad.xyz/reference/rpc-limits)。这里只列对实现有影响的摘要，具体参数以链接为准。

Monad 官方文档支持 Agentic Payments，并列出 x402 Facilitator 与 MPP SDK。它们适合补充按调用付费能力；本项目的任务期限、结果承诺、拒绝重开和 escrow 仍由 TaskManager 定义。[Agentic Payments](https://docs.monad.xyz/tooling-and-infra/agentic-payments)

当前 x402 教程注明 Facilitator 支持 v2 及以上，并建议 `@x402/evm >= 2.22.0`；Testnet USDC 配置与 Mainnet 内置配置有区别。做 P2 集成时核对 `/supported` 与 SDK 配置，不复制旧版示例。[x402 教程](https://docs.monad.xyz/guides/x402)

MPP 示例默认连接 Mainnet，使用 Testnet 需要显式配置。pull/push 支付分别涉及签名授权和广播交易，不能认为现有 Vault session signer 自动具有这些付款权限。[MPP Overview](https://docs.monad.xyz/reference/mpp/overview)

EIP-7702 在 Monad 有特定限制，包括 delegated EOA 余额降低到 10 MON 以下时的行为，以及委托代码执行 `CREATE/CREATE2` 的限制；这不是“所有普通 EOA 都必须持有 10 MON”。因此首版使用 Vault，后续再独立评估账户抽象。[EIP-7702 on Monad](https://docs.monad.xyz/developer-essentials/eip-7702)

## 5. 相关工程标准

| 资料 | 用途 |
| --- | --- |
| [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785) | TaskSpec、ResultManifest 的确定性 JSON 编码 |
| [OpenZeppelin ERC-20 / SafeERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20) | 托管转账与代币交互 |
| [MCP Server 官方教程](https://modelcontextprotocol.io/docs/develop/build-server) | 在 SDK 稳定后添加 MCP adapter |
| [Monad 文档索引 llms.txt](https://docs.monad.xyz/llms.txt) | 快速定位现行官方资料，减少使用旧路径 |

建议阅读顺序：**Testnet → Foundry → Deployment Summary → USDC → WebSocket/RPC → ERC-8004 → Agentic Payments**。x402、MPP、7702 和 Execution Events 等 P0 闭环完成后再深入。

## 6. Sponsor perks：建议优先使用哪些

以下额度和估值来自用户粘贴的资源页 Agent 版本，规则为每队每项一个 voucher。领取页本次未成功读取，未核实兑换期限、续费、超额计费或实际发放条件，也未领取任何额度；数额是页面宣传估值，不是现金或已获得的余额。

| 优先级 | 福利 | 页面标示价值 | 本项目用途 | 领取说明 |
| --- | --- | --- | --- | --- |
| 1 | QuickNode Build Plan，三个月 | 约 $147 | 任务日志、RPC、WebSocket；降低公共端点限流影响 | [领取页](https://www.notion.so/quicknode/Quicknode-Credits-for-Metropolis-Hackers-3cd15a82e84c8093b33af5fee0452ca9) |
| 2 | Tenderly Pro | 约 $7,200；提供的摘要未注明时长 | 排查 claim/accept/reject revert，模拟 Vault 限额和资金路径 | [领取页](https://www.notion.so/monad-foundation/Tenderly-Access-for-Metropolis-participants-3ce6367594f280539f27d268d05431cd) |
| 3 | Zerion API Builder，团队一个月 | 约 $149 | 只有扩展钱包分析任务时再接入 | [领取页](https://zerion.notion.site/Free-Zerion-API-Builder-Plan-3cead18255da810aa409ebdcceb05ed3) |

推荐实际组合是 **QuickNode RPC + Foundry 测试 + Tenderly 调试**。P0 仍用小型可重放索引器；是否替换 Envio 按事件量、开发熟悉度和演示稳定性决定。赞助额度不改变协议架构，也不意味着 QuickNode Streams 等所有产品都包含在该 plan 中，使用前核对。

## 7. 技术摘要与一手资料的差异

| 资源摘要中的说法 | 本次核对结果与处理 |
| --- | --- |
| MERA 是执行与 runtime 架构指南 | 当前正文是 Passkey 派生 EOA 教程；放入 Owner 钱包体验备选，不作为 Agent 执行引擎 |
| Alchemy MCP 无需 API key | 当前支持 OAuth 登录并选择 app；不等于匿名、免费无限使用 |
| ERC-8004 提供身份与信誉 | 正确，但规范仍为 Draft；支付不在规范内；Monad 指南的 Validation Registry 仍标 coming soon |
| 400 ms 出块、800 ms finality | 当前 Deployment Summary 标为 300 ms 与 600 ms；不将目录中的旧数值写成应用 SLA |
| P256 应假定不可用 | 当前概要已列出 `0x0100` 的 EIP-7951 P256 验证；若未来接入 passkey 合约钱包，按目标网络 revision 实测 |

依据：[Mera](https://docs.monad.xyz/guides/mera)、[Alchemy MCP](https://www.alchemy.com/docs/alchemy-mcp-server)、[ERC-8004 规范](https://eips.ethereum.org/EIPS/eip-8004)、[Monad ERC-8004 指南](https://docs.monad.xyz/guides/erc-8004)、[部署概要](https://docs.monad.xyz/developer-essentials/summary)。这些差异说明资源目录适合发现工具，具体接口、链参数和支持状态应以对应现行文档为准。

## 8. 资源如何接入本项目

| 层次 | 建议 | 明确边界 |
| --- | --- | --- |
| 身份 | ERC-8004 + 可选 Trust8004 | 不代替 `msg.sender`、Vault 授权或结果验证 |
| Agent 入口 | 自有 Requester MCP + Skill | 提供 hire、查询、验收等语义工具 |
| Worker 数据工具 | Alchemy / Zerion 的必要只读能力 | 不把通用签名、交易、钱包管理工具交给 Worker 模型 |
| 托管与结算 | 自研 TaskManager + RequesterVault | 是本项目的核心交付 |
| RPC / 索引 | QuickNode + 自建日志视图；或 Envio | 可替换、可回放，不成为支付正确性的唯一依据 |
| 同步付费接口 | x402 / MPP | 后续明确设计支付账户与限额；与异步 escrow 分离 |
| Owner onboarding | 浏览器钱包起步；后续选 MERA 或一个嵌入式钱包方案 | 不同时接入多家钱包 SDK |

其余 Aave、Morpho、Euler、Perpl、Uniswap 等 SDK，只有未来新增特定 DeFi Worker 时才有必要；当前研究与 Transfer 分析无需引入交易协议。Farcaster、React Native、PWA 模板也不改变现有 Web Explorer 的首版交付目标。

Trust8004 的主页已列出 Monad；资源页给出的 API 能力仍需按实际端点与网络验证，本文不编造 API URL、SLA 或免费配额。[Trust8004](https://trust8004.xyz/)
