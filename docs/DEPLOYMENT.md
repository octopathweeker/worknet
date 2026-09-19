# 自行部署

源码不附带现有线上环境。所有地址、身份、服务 URL 和凭证都应来自部署者自己的配置。

## 构建与本地验收

```sh
pnpm install --frozen-lockfile
pnpm setup:tools
pnpm check
pnpm demo
```

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

已完成充值根据命令状态和交易回执清理；未完成操作保留原 intent。不要清空事务日志来重试未知结果。
