# M6 正式环境与云端裁决

M6 是当前正式产品环境，沿用已绑定的 HTTPS 域名和现有 M6 资源，链仍为 Monad Testnet。日常更新使用 `pnpm deploy:production`，操作与密钥说明见 [部署文档](DEPLOYMENT.md)。下面的新建步骤仅用于初次建立隔离环境，不是每次发布流程。

新版研究任务使用 `jev.quorum/1.0.0`；链上分析继续独立复算。三个 judge 各自部署为 Cloudflare Worker，拥有独立签名密钥和 Durable Object 评分缓存。平台验证签名和注册身份、去重、达到 2-of-3 后上链，偶数评分取较低中位数。评分缓存和交易 outbox 在进程重启后继续使用。

## OpenRouter

复用原平台的 `OPENROUTER_API_KEY` Secret。原平台新增受 `MODEL_GATEWAY_TOKEN` 鉴权的内部网关；新平台和 judge 通过 Service Binding 调用，不读取或导出已有 key。

- Jev: `POST https://openrouter.ai/api/v1/systemone`，模型 `jev-1.13`。
- 生成仍使用原来的 OpenRouter 免费模型配置。
- judge 先核对 finalized 链上任务、轮次、发起方、执行方及 spec/result hash，再抓取允许的研究来源，向 Jev 提供引文上下文和完成度 rubric。
- HTTP 429/529 有限退避重试。每轮交付每个 judge 最多四次评估尝试；成功签名持久保存，不反复抽样。平台网关有单独的 Jev 每日请求额度和分钟限流。

接口依据：[OpenRouter TypeSafe SDK](https://openrouter.ai/docs/guides/community/typesafe-sdk)、[TypeSafe Score](https://docs.typesafe.ai/primitives/score.md)。Jev 是概率加权连续评分，因此付款比例可以不是 25% 的整数倍。评分不构成任意事实正确性的保证，多个实例使用相同模型也不消除相关性。

## 与旧版本并行

`scripts/prepare-m6.ts` 使用 `.runtime/m6/` 下的新事务日志、角色密钥、新合约、新 Factory、新 Worker 域名和新 D1。不能把旧 D1 或旧 Vault 直接指向新 Manager。旧站继续服务旧任务，余额及权限不自动迁移。

历史账户迁移步骤：在旧站收尾任务；Owner 提取旧 Vault 的可用余额；在新版连接同一钱包，创建新 Vault、充值并重新授权。当前正式产品已隐藏旧站和原团队工作区入口及迁移提示，历史站点仍保留。仅钱包 Owner 能转出旧预算，平台部署不会代替用户操作。

准备与部署顺序：

```sh
pnpm check
pnpm exec tsx scripts/prepare-m6.ts
pnpm exec tsx scripts/prepare-m6.ts --broadcast
```

上面的广播只部署新 Testnet 合约并给专用服务账户分配 test MON。使用独立锁和持久签名日志，重试不重复发交易；已部署合约与构造参数变化会报错。旧 `prepare-platform.ts` 检测到旧 Manager 时拒绝将其误认为 M6。

1. 为原平台加入 `.runtime/m6/gateway-secrets.json`，部署内部网关代码并保留其既有 secrets。
2. 用 `.runtime/m6/judge-N.wrangler.jsonc` 部署三个 judge，并导入对应 `judge-N.secrets.json`。
3. 为新版新建 D1，ID 写入 `.runtime/m6/database.json` 和新版 Wrangler 配置。执行 `schema.sql` 与 `platform-schema.sql`。
4. 导入 `.runtime/m6/platform-secrets.json`，部署新版平台。不要把这些 secret 文件提交或输出到日志。
5. 验证三个 judge 的健康、未授权评估拒绝、真实 Jev 请求、两位专用测试用户的发布/交付、实际链上付款与退款；复查旧站配置与健康。

## 结算与失败语义

前端分开显示已收签和已确认付款。最终付款和退款只来自成功交易回执中的 `VerdictSettled`，不把预计金额当作到账证明。接单历史只展示匹配本轮与交付 hash 的结算。

本次保留协议原有的 Owner accept/reject 与审核超时全额付款规则。裁判不足时平台重试，临近截止尝试拒绝；授权失效或服务离线仍可能进入原超时结算。发布确认页明确展示此规则。这不是强制排他的裁决通道，也不是完整争议仲裁协议。

## 验证范围

新增测试覆盖签名去重、非法分数、跨轮次/跨链 replay、金额舍入守恒、OpenRouter fractional Score 与限流重试、内部网关鉴权、三个独立持久 judge、收款交易确认时崩溃恢复、单 judge 离线及 2-of-3 下中位分账。公网结果以忽略目录 `.runtime/m6/` 的实际验证记录为准；本地测试不等同于真实钱包扩展或独立设备验收。

## 本次验证结果

完整回归通过：28 Foundry + 88 Node。公网已用复用的 OpenRouter key 验证 Jev 实际调用；分别完成平台生成研究交付、独立钱包领取开放任务并提交不完整交付，两次均产生 `JUDGE_VERDICT` 结算，付款与退款之和等于托管奖励。桌面与 390px 手机页面已检查，新版预算页提供旧站入口。测试身份为专用软件钱包，未宣称真实扩展钱包及独立设备验收已完成。
