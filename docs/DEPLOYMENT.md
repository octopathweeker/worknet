# 自行部署

源码不附带现有线上环境。所有地址、身份、服务 URL 和凭证都应来自部署者自己的配置。

## 当前正式发布目标

M6 已被指定为产品正式环境，网络保持 Monad Testnet（10143）。使用 `.runtime/m6/wrangler.jsonc` 中已绑定的固定 HTTPS 域名；该配置设置 `WORKNET_ENVIRONMENT=production` 和 `WORKNET_PUBLIC_ORIGIN`。`/platform/config` 返回这两个公开发布信息。Worker 名称、D1、Durable Object、合约、角色账户与历史任务沿用现有 M6，旧站继续服务旧任务与模型网关。

```sh
pnpm deploy:production --dry-run
pnpm deploy:production
```

命令核对 M6/10143、正式域名、数据库与裁判绑定，检查 Cloudflare 登录，构建前端和下载资源，追加数据库表；如果存在 `.runtime/m6/protocol/wrangler.jsonc`，先更新独立 MPP 工具服务，再发布三个裁判和平台。首次部署者仍需按下文准备自己的资源；本命令不会创建新合约、转移余额或发放测试币。不要加 `--env production` 创建另一套 Worker/DO，也不要为更新代码重新运行 `prepare-m6.ts --broadcast`。

私有交付使用单独保存在 `.runtime/m6/privacy-secrets.json` 的 `DELIVERY_REVIEW_KEY`，通过 `wrangler secret bulk` 首次导入；日常发布保留所有已有 Secrets。备份密钥并保持稳定，不能在重新发布时生成替代密钥。发布前备份 D1，发布后检查 health、公开配置、裁判鉴权、下载校验码和 Mera 登录页。部署及验证记录存放在忽略目录 `.runtime/m6/`。

## 构建与本地验收

```sh
pnpm install --frozen-lockfile
pnpm setup:tools
pnpm check
pnpm demo
```

Explorer 的 `build` 在 Vite 清理并生成页面后，自动打包 taker 客户端、SHA-256 和两份接入指南到 `dist/downloads/`。单独更新前端时也使用 `pnpm --filter @agent-task/explorer build`；直接运行 `vite build` 会跳过下载资源生成。发布后检查 `/downloads/worknet-taker.mjs`、`/downloads/worknet-taker.sha256`、`/downloads/taker-guide.md` 与 `/downloads/market-guide.md` 均返回 200，并核对客户端校验码。

只需使用已有官方工具链时，可设置 `FOUNDRY_BIN` 为其目录。不要把本地演示公开开发账户用于 Testnet 或真实资金。

## Monad Testnet

链 ID 为 10143，默认公共 RPC 为 `https://testnet-rpc.monad.xyz`。Circle Test USDC 和官方 Delegation Framework 地址属于公共网络依赖，代码与 fixture 中保留这些地址。

`pnpm testnet:prepare` 生成专用测试账户及角色配置，保存在 `.runtime/testnet-accounts/`。为部署者准备 test MON、为资金 Owner 准备 test USDC；不要导入个人主钱包。`.env.example` 仅是字段说明，应用不会自动加载它。

独立平台合约准备流程：

```sh
pnpm contracts:build
pnpm exec tsx scripts/prepare-platform.ts
# 检查预检结果后，设置自己 Worker 的 HTTPS origin，再显式广播：
STORAGE_URL=https://your-worker.example.com pnpm exec tsx scripts/prepare-platform.ts --broadcast
pnpm exec tsx scripts/configure-platform.ts
```

部署/资金事务使用持久 intent 和签名日志；再次执行会恢复既有操作，不应删除运行目录规避错误。`configure-platform.ts` 生成 `.runtime/platform/cloudflare-secrets.json`，包含平台角色密钥，保持本机权限并勿提交。平台、Factory、角色和来源 URL 均从生成的配置读取。

## Cloudflare

`apps/object-store/wrangler.jsonc` 是模板，D1 ID 为占位符。先复制为忽略的 `apps/object-store/wrangler.local.jsonc`，设置自己 Worker 名称和 D1 数据库 ID；登录自己的账户。

```sh
npx wrangler@4.135.0 whoami
npx wrangler@4.135.0 d1 create worknet-platform
# 将返回的数据库 ID 写入 wrangler.local.jsonc
npx wrangler@4.135.0 d1 execute worknet-platform --remote --config apps/object-store/wrangler.local.jsonc --file apps/object-store/schema.sql
npx wrangler@4.135.0 d1 execute worknet-platform --remote --config apps/object-store/wrangler.local.jsonc --file apps/object-store/platform-schema.sql
npx wrangler@4.135.0 secret bulk .runtime/platform/cloudflare-secrets.json --config apps/object-store/wrangler.local.jsonc
pnpm build
npx wrangler@4.135.0 deploy --config apps/object-store/wrangler.local.jsonc
```

Workers AI、D1 和 Durable Object bindings 已在模板中声明。TaskSpec 的 storage origin 必须与实际 Worker URL 一致。按需通过 Wrangler secrets 配置旧工作区的 `STORAGE_UPLOAD_TOKEN` 和 `WORKSPACE_ACCESS_CODE`，不要写进静态文件。

云端启用 sponsor/operator/worker 后，不得在另一进程同时使用这些 signer 的私钥。普通 Owner 操作和测试账户由各自钱包签名。`verify-7702.ts` 在云端接管 signer 之前运行；`verify-platform.ts` 可验证自己的公网 API。历史研究回放脚本需要本机忽略目录中的原始证据与配置，这些输入不随公开提交分发；本地研究正反例回归位于 `tests/platform.test.ts`。

## 充值与权限

金额输入为 USDC，精度 6 位；例如 0.5 编码为 500000。充值范围 0.01–5 test USDC。当前充值同时更新 24 小时自动任务付款授权，累计额度为本次充值金额、单笔最多 0.20；已有任务可能需要 Owner 接管审核。GUI 会在确认前说明这些限制。

主流程为「连接钱包 → 充值 → 发布任务」。 浏览器新建的充值和付款授权使用钱包交易；7702 链上代码不代表钱包允许外部 Delegation typed-data 签名，MetaMask 管理的账户会拒绝这类原始签名请求。仅已保存签名或已提交的旧代付请求继续原路线，避免重复执行。新钱包交易的手续费由钱包展示并支付，需要 test MON。余额充足但付款授权过期、撤销或额度不足时，「确认并发布」自动准备 `authorizeAgent`，用户按钱包提示确认后继续发布同一任务，无需再次充值或跳转预算页。该准备操作不转移 USDC；24 小时累计额度取当前余额（最多 5 test USDC），单笔最多 0.20，在发布页可展开查看。更新授权会开启新周期，已有任务可能需要 Owner 接管审核。发布先恢复已有发布命令，再校验同一区块的余额、权限和链上时间。旧充值的最后一笔 `authorizeAgent` 已经过期时，可以退出当前发布恢复流程：保留原交易记录和未知状态，不重发充值、不依赖钱包是否仍保存批量历史。有效期以链上调用中的授权截止时间判断，不能用较短的赞助签名有效期代替。新的一笔普通钱包授权使用单笔交易 hash 恢复；钱包报告完成后仍需链上权限就绪才会提交任务。

已完成充值根据命令状态和交易回执清理；未完成操作保留原 intent。不要清空事务日志来重试未知结果。

资源节流、QuickNode RPC/通知、OpenRouter 免费模型及最后由用户填写的 Secret，见 [资源配置](RESOURCE-CONFIGURATION.md)。已有部署先追加 schema，再切换配置和部署。

## Mera、私有交付和工具支付

参见 [Mera 运行说明](MERA-ACCOUNTS.md) 与 [ERC-8004/MPP 配置](ERC8004-MPP-INTEGRATION.md)。本轮不修改 TaskManager/Vault 合约，无需仅为这些功能迁移已部署的任务合约。先追加执行 platform-schema.sql，再将 TOOL_PAYMENTS binding 和 tool-payments-v1 migration 同步到私有 wrangler 配置。私有交付需要 DELIVERY_REVIEW_KEY；MPP 和 ERC-8004 按需显式配置，未配置时不伪报已接入或已付款。

主平台默认 Mera 登录，旧浏览器钱包用户使用 `/?account=external`。固定 HTTPS hostname 后再为用户创建 Passkey；不能让用户在临时预览域创建有资产的账户后直接切换域名。测试 MON/USDC 只通过页面链接由用户自行领取，没有自动赠币配置或平台领币池。
