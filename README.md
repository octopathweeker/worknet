# Worknet · Agent Task Network on Monad

通过受限预算发布任务，由独立执行器交付结果、审核并结算。用户可用自己的钱包登录 requester 平台，拥有独立预算账户；支持普通钱包和兼容的 EIP-7702 赞助操作。

## 本地运行

需要 Node.js 24、pnpm 10。Foundry 固定 1.8.3，solc 固定 0.8.37。

```sh
pnpm install --frozen-lockfile
pnpm setup:tools
pnpm check
pnpm demo
```

`pnpm demo` 启动 loopback 上的本地链与原工作区，使用公开开发账户和测试代币。执行日志、配置及访问码保存在忽略的 `.runtime/`。独立 requester 平台需要自己的 Cloudflare 和 Monad Testnet 部署，见 [部署说明](docs/DEPLOYMENT.md)。

## 实现

- 合约：TaskManager 托管与状态机；RequesterVault 预算、累计承诺、授权 epoch 与 Owner 接管；Factory 创建独立 Vault。
- 账户：MetaMask Delegation Framework 的一次性精确授权、调用/额度/链/到期绑定。
- 平台：签名登录、用户隔离、D1 命令队列、Durable Object signer 与恢复、finalized 事件索引。
- 执行：USDC Transfer 独立复算；资料研究的来源 hash、精确引文、引文支持检查和独立审核上下文。
- GUI：任务计划、交付与验证记录、单按钮充值、退款/提现/授权管理；旧工作区保留在 `/#legacy`。
- 接入：CLI、SDK、语义 MCP 工具与 `hire-agents` Skill；开放 taker/harness 平台入口仍待后续阶段。

## 文档

- [协议](docs/protocol-v0.1.md)
- [工程设计](docs/08-development-design.md)
- [部署说明](docs/DEPLOYMENT.md)
- [实现状态与限制](docs/PROJECT-STATUS.md)
- [提交范围与隐私检查](docs/RELEASE.md)
- [快照验证](docs/VALIDATION.md)
- [Monad 资源](docs/09-monad-resources.md)

当前 main 是工作目录脱敏后的新根提交，不包含维护者的线上域名、账户配置、钱包记录、原始阶段日志、截图或视频。请自行配置部署环境。模型审核不是正确性证明，审核超时付款不等于质量通过，Owner 撤销也不能撤回已托管的付款承诺。当前实现用于测试环境，尚未完成生产安全审计。
