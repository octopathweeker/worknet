# M0 冻结基线：agent-task/0.1

日期：2026-09-19。这是 M1 开始实现的协议规范；`08-development-design.md` 为总体设计，`00–07` 为原始构想。本阶段代码中的 TaskRules 是纯辅助函数，接口没有资金逻辑。

## 1. 唯一来源与版本

- Solidity struct、枚举、接口以 `contracts/src` 为准；ABI 通过固定版本 solc 生成。
- wire schema 以 `packages/protocol/src/schemas.ts` 为准；TS 类型由 schema 推导，外部 JSON Schema 由脚本生成。
- `protocol = agent-task/0.1`；capability/profile 使用独立 `x.y.z` 版本。
- 变更 ABI/schema/编码顺序时，同步修改规范、固定向量与阶段记录。未部署前可以审查后变更 0.1；部署后破坏性变更必须新版本与新部署。
- 此次 solc 锁为 0.8.37，测试 harness 输出 Shanghai 字节码。该选择用于通用 EVM 纯函数测试；M1 Monad 配置必须独立对齐执行网络及编译目标。

## 2. 身份、数值和状态

- task 全局键：`(chainId, TaskManager address, taskId)`；执行键再加 attempt。
- wire 地址、bytes32 使用小写十六进制；先完成规范化再发布 commitment，读取时不能悄悄改动原 JSON。
- 金额、chainId、taskId、attempt、blockNumber 用无前导零十进制字符串。金额单位是 token 原始单位。
- 绝对时间以整数 Unix 秒传输，限制在 JS safe integer 范围；Solidity 使用 uint64。时长用 uint32；金额使用 uint128；taskId 使用 uint256。
- 状态码固定为 OPEN=0、CLAIMED=1、SUBMITTED=2、SETTLED=3、CANCELLED=4、EXPIRED=5。
- 未存在 mapping 的零值不能解释成 OPEN：必须检查 requester 非零；未知 taskId 的 getTask 应 revert。
- taskId 从 1 开始；getTaskByRequestId 未命中返回 0。attempt 从 0 开始，每次成功 claim 加 1，永不回退。
- 结算原因 REQUESTER_ACCEPT=0、REVIEW_TIMEOUT=1。前者证明 Requester 接受，不证明链上运行过语义校验。

## 3. JSON、hash 与编码

| 内容 | 编码/定义 |
| --- | --- |
| specHash / resultHash | `keccak256(UTF8(JCS(document)))` |
| capabilityId | `keccak256(abi.encode(string capability, string capabilityVersion))` |
| clientRequestId | 链上非零 bytes32；SDK 可用 `keccak256(UTF8(logicalKey))`，逻辑 key 最多 256 UTF-8 bytes |
| create 参数 hash | `keccak256(abi.encode(address operator, CreateTaskParams params))`；按 Solidity tuple 编码，不能改成 packed 或扁平 tuple |
| 附件 hash | 原始附件 bytes 的 keccak256；不自动按 JSON canonicalize |

CreateTaskParams 顺序固定为 `capabilityId, specHash, specURI, rewardAmount, taskDeadline, claimLeaseSeconds, reviewWindowSeconds`。Requester 由 msg.sender 决定，clientRequestId 由 mapping key 决定，token 由 Manager immutable 决定，因此不重复进入 params。

严格解析禁止重复 key（包括转义后相等的 key）、非有限数、不安全整数、非法 Unicode、错误 UTF-8 和过深 JSON；对象 API 还拒绝 getter、Date、toJSON、symbol、undefined、稀疏数组与循环引用。数字规则有意比通用 JCS 更严格，大整数必须转字符串。Unicode 保持原样，不执行 NFC/NFD 归一化。

每个 JSON 输入或 canonical 输出不超过 256 KiB，深度不超过 64；URI 不超过 512 UTF-8 bytes；附件最多 16 个，总 declared size 不超过 5 MiB。附件实际大小/hash 由 M2 存储层再次验证。URI/schema 校验不代替 DNS、重定向和 SSRF 防护。

TaskSpec 包含链/Manager/Requester/request ID、capability、input、outputSchema、reward、execution 与 verification。结果包含 taskId/attempt/worker/specHash 与 output。下载内容后必须先核对链上 hash 与经济参数，再验证输出。

outputSchema 采用 draft-07。M0 只验证 schema 文档合法性，不编译并执行任意用户输出校验、不解析远端 `$ref`；M3 应在受限执行边界运行不可信 schema/Judge。Verifier 不得把 schema 成功当作语义正确。

## 4. 创建参数与时间

- reward、clientRequestId、operator、capabilityId、specHash 非零；specURI 非空且长度有界。
- `now < taskDeadline <= now + 86400`。
- `0 < claimLeaseSeconds <= taskDeadline - now`。
- `60 <= reviewWindowSeconds <= 1800`。
- `leaseExpiry = min(now + claimLeaseSeconds, taskDeadline)`。
- submit 成功时 `reviewDeadline = submittedAt + reviewWindowSeconds`，不截断到 taskDeadline。创建需拒绝 uint64 review 上溢，虽然正常时间不会接近上限。
- Agent 创建要求 `taskDeadline + reviewWindowSeconds < authorization.validUntil`。
- `now` 来自链上区块时间；SDK 本地 preflight 只是提示，不能替代合约校验。

## 5. 状态机与权限

| 当前状态 | 调用者和操作 | 时间条件 | 结果 |
| --- | --- | --- | --- |
| 无 | requester 创建并足额转入奖励 | 创建参数有效 | OPEN |
| OPEN | 任意非零 worker claim | now < taskDeadline | CLAIMED；attempt++ |
| CLAIMED | assigned worker submit，attempt 匹配 | now < leaseExpiry 且 now < taskDeadline | SUBMITTED |
| SUBMITTED | requester accept，attempt/resultHash 匹配 | now < reviewDeadline | SETTLED，支付 worker |
| SUBMITTED | requester reject，attempt/resultHash 匹配 | now < reviewDeadline | now < taskDeadline 则 OPEN，否则 EXPIRED+退款 |
| SUBMITTED | 任何人 finalize | now >= reviewDeadline | SETTLED，支付 worker |
| CLAIMED | 任何人 releaseExpiredClaim | now >= leaseExpiry | now < taskDeadline 则 OPEN，否则 EXPIRED+退款 |
| OPEN / CLAIMED | 任何人 expireTask | now >= taskDeadline | EXPIRED+退款 |
| OPEN | requester cancelTask | now < taskDeadline | CANCELLED+退款 |

SUBMITTED 永远不能走 expireTask；lease/task 到期和审查期到期不是一件事。REQUESTER_ACCEPT 过审查期后也不能再调用，应走 finalize，确保结算原因一致。

reject/release 清空当前 worker、结果与所有当前尝试时间，不清空 attempt；先发带原 worker/attempt/resultHash 的事件，再表达 reopen/expire。ResultRejected 之后未过期发 TaskReopened，已过期发 TaskExpired；ClaimReleased 同理。TaskCancelled/TaskExpired/TaskSettled 各自包含实际资金金额。

所有终态禁止再次移动资金。函数不会自动运行；deadline 到期后仍需某个进程发交易。

## 6. 幂等与授权

Manager 用 `(msg.sender, clientRequestId)` 定位已创建任务。命中且 paramsHash 相同则直接返回原 taskId，即使原任务已终态或原 deadline 已过；参数不同 revert，不再转 token。首次创建失败不得占用 request ID。

Vault 的 createTask 只供有效授权 Agent 使用；Owner 如果要从 Vault 创建任务，需要显式给自身授权并遵守同一额度。Owner 无需授权即可充值/提现/管理授权及接管已存在任务。

Vault create 顺序：检查当前 Agent active、时间窗口和 paused → 查询已有 request ID → 命中时检查原 operator/epoch 与 paramsHash → 返回原 taskId；未命中才检查单笔/累计额度、任务完整时间、余额并创建。幂等命中不能重新记 committed 或重绑权限。

authorizeAgent 仅 Owner：`validAfter < validUntil`、validUntil 尚未过期、`0 < maxPerTask <= maxTotalCommitment`；新 epoch 为旧 epoch+1，committed 归零。revoke 也递增 epoch 并取消 active。整数上溢必须回滚。

task authority 绑定创建时 `(operator, epoch)`。非 Owner 的 accept/reject/cancel 必须同时满足 task operator、epoch、当前授权时间/active。同一地址新授权不能接管旧 epoch 任务。

Vault pause 阻止 Agent 创建、接受、拒绝与取消；Owner 仍能接管、提现和撤销。pause/revoke 不修改 Manager 的既有托管承诺，也不能阻止已经到期的 finalize。

deposit 允许任何地址转入；withdraw 仅 Owner、recipient 非零且只提取 Vault 当前未托管余额。Owner 固定，不做所有权转移/升级。Vault 无 arbitrary execute。token 和 Manager 为 immutable，构造时检查非零、代码与 token 一致性。

## 7. M1 必须执行的经济不变量

- token balance >= totalEscrowed；后者等于 OPEN/CLAIMED/SUBMITTED 奖励总和。
- 奖励创建时完整转入，reject/release 的重开不重新收款，不重复增加 committed。
- 每任务最多付款或退款一次；Token 转账失败连同状态/额度变更全部回滚。
- 所有付款发给 assigned worker，退款发给 requester。operator metadata 不授予 Manager 权限。
- 退款不恢复 session committed；合约不依赖事件索引器、Judge 或身份注册表裁决权限。
- 精确金额检查、SafeERC20、CEI、重入防护放入实现。只接受固定 token，不承诺支持转账税/重基准资产。

## 8. 本阶段可执行证据与未覆盖范围

执行 `pnpm check`。固定样例在 `tests/fixtures`，Solidity harness 的实际 EVM 输出与 TypeScript 比较 hash、tuple 编码和时间边界。

未实现：TaskManager/Vault storage 与 ERC-20 资金移动、完整权限、nonce/retry/runtime、存储服务、Verifier 执行、任何网络部署。上述不变量和状态机是 M1 的验收要求，不能用 M0 测试通过替代。

参考：[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)、[Ajv draft-07](https://ajv.js.org/json-schema.html)、[Monad Foundry](https://docs.monad.xyz/tooling-and-infra/toolkits/foundry)。
