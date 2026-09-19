# Requester Wallet & Agent Authorization Design

## 1. 文档目的

本文定义 Requester 侧的资金与授权模型。

核心问题是：

> **如何让一个 Agent 可以自主花钱雇佣其他 Agent，但不能获得 Owner 资产的完整控制权？**

系统不应该采用：

```text
User Private Key
      ↓
     Agent
```

而应该采用：

```text
Owner Wallet
     │
     │ fund + authorize
     ▼
Requester Vault
     │
     │ limited authority
     ▼
Agent Session Signer
     │
     ▼
Task Protocol
```

核心原则：

> **Give your agent a budget, not your private key.**

---

# 2. 设计目标

Requester Wallet 必须满足五个基本目标。

### 2.1 Agent 可以自主花钱

Owner 完成一次授权后，Agent 不需要每创建一个 Task 都请求人类签名。

---

### 2.2 Agent 不能任意转移资金

Agent 只能：

```text
创建 Task
管理自己创建的 Task
验证 Result
```

不能：

```text
withdraw()

transfer()

approve arbitrary contract

execute arbitrary calldata
```

---

### 2.3 Agent 泄漏不会导致整个钱包失守

如果 Agent Session Key 被攻击者拿到：

攻击者能造成的损失应该被严格限制在：

```text
Agent Remaining Budget
```

而不是：

```text
Owner Wallet Balance
```

---

### 2.4 Owner 可以随时撤销 Agent

Owner 必须能够：

```text
revoke
pause
take over
withdraw available funds
```

---

### 2.5 Agent 资金行为必须可审计

我们应该能够回答：

```text
这个 Agent 被授权了多少钱？

已经创建了多少任务？

还剩多少预算？

每一笔钱被花去了哪里？
```

这些信息应该能够从 Monad 上得到。

---

# 3. 核心角色

资金系统定义三个不同身份。

## Owner

真实的资产所有者。

通常是：

```text
Human Wallet
```

Owner 拥有：

```text
RequesterVault ownership
```

Owner 可以：

```text
deposit
withdraw
authorizeAgent
revokeAgent
pauseVault
manage emergency cases
```

---

# 4. RequesterVault

RequesterVault 是 Agent 与 Owner 资金之间的安全边界。

它不是简单的：

```text
ERC20 Wallet
```

而更接近：

> **A programmable spending firewall for agents.**

它只允许 Agent 执行预定义的经济行为。

```text
                    Owner
                      │
              deposit / policy
                      │
                      ▼
             ┌─────────────────┐
             │ RequesterVault  │
             │                 │
             │     50 USDC     │
             └────────┬────────┘
                      │
              controlled spend
                      │
                      ▼
                TaskManager
```

---

# 5. Agent Session Signer

Requester Agent 不使用 Owner Wallet。

每一个 Agent Runtime 使用独立的：

```text
Agent Session Signer
```

例如：

```text
0xAgent123...
```

它拥有自己的 private key。

但这个地址本身：

```text
不持有 Owner USDC
```

它只是被 RequesterVault 授予有限权限。

概念上：

```text
Owner
  │
  │ authorize
  ▼
Agent Address
  │
  │ allowed to spend <= 10 USDC
  ▼
RequesterVault
```

Agent Signer 可以理解为：

> **Session Key / Operator Key**

---

# 6. Private Key Boundary

一个非常重要的安全原则：

> **LLM 本身永远不应该看到 private key。**

架构应该是：

```text
LLM / Agent
     │
     │ tool invocation
     ▼
Requester SDK / MCP
     │
     ▼
Signer Adapter
     │
     │ private key lives here
     ▼
Monad
```

例如：

```text
Agent:
"hire a research worker for 1 USDC"

        ↓

MCP Tool:
hire_agent(...)

        ↓

Requester SDK

        ↓

Local Signer

        ↓

RequesterVault.createTask()
```

Private Key：

```text
不进入 prompt

不进入 tool result

不进入 Agent memory

不进入 logs
```

Hackathon Demo 中可以使用：

```text
local encrypted key
```

或开发环境：

```text
environment variable
```

但生产设计应该支持：

```text
KMS
HSM
Secure Enclave
Wallet infrastructure
```

---

# 7. 为什么不用 Owner Wallet 直接跑 Agent

最简单的实现当然是：

```text
OWNER_PRIVATE_KEY=...
```

然后 Agent 直接发送交易。

但这意味着 Agent 一旦：

```text
prompt injected

runtime compromised

dependency compromised

private key leaked
```

攻击者可能直接：

```text
transfer all USDC
transfer NFTs
interact with arbitrary contracts
drain assets
```

这与 Autonomous Agent 的安全模型不匹配。

Agent 应该获得的是：

> **Capability**

而不是：

> **Full Custody**

---

# 8. Agent Authorization

Owner 可以调用：

```text
authorizeAgent()
```

为一个 Agent 创建 Authorization。

概念模型：

```solidity
struct AgentAuthorization {
    bool active;

    uint64 validAfter;
    uint64 validUntil;

    uint128 maxPerTask;
    uint128 maxTotalCommitment;

    uint128 committed;
}
```

例如：

```text
Agent:

0xAgent123

Policy:

Valid for          24 hours
Max per task        2 USDC
Total budget       10 USDC
```

意味着：

```text
这个 Agent 在未来 24 小时内

最多创建：

10 USDC

的任务，

并且单个 Task：

不得超过 2 USDC。
```

---

# 9. 为什么第一版使用 Session Budget

之前我们讨论过：

```text
dailyBudget
```

MVP 中建议进一步简化为：

```text
Session Spend Limit
```

例如：

```text
Authorization expires:   24 hours
Spend limit:              10 USDC
```

效果上就是：

> 10 USDC / 24 hours

但 Solidity 不需要实现复杂的 rolling window accounting。

下一次 Owner 可以重新授权：

```text
new session
↓
new budget
```

未来再扩展：

```text
hourly limit

daily limit

weekly limit

rolling window
```

---

# 10. Commitment，而不是 Settlement

预算统计采用：

```text
committed
```

而不是：

```text
actually paid
```

例如 Agent 创建：

```text
Task A → 1 USDC
```

那么：

```text
committed += 1 USDC
```

即使 Task 最后：

```text
expired
↓
refund
```

本次 Session 的：

```text
committed
```

也不减少。

这是刻意设计的。

因为这样：

```text
Authorization

10 USDC
```

真正意味着：

> **这个 Session 最多可以创建 10 USDC 的新经济承诺。**

不会因为：

```text
cancel → refund
create → cancel → refund
```

不断恢复权限。

这个模型更保守，也更容易审计。

---

# 11. Policy Check

Agent 创建 Task 时：

```text
createTask(reward)
```

Vault 检查：

```text
authorization.active == true
```

以及：

```text
now >= validAfter
```

```text
now < validUntil
```

```text
reward <= maxPerTask
```

```text
committed + reward
<=
maxTotalCommitment
```

同时：

```text
vaultBalance >= reward
```

全部满足后才能创建 Task。

---

# 12. Session Lifetime 与 Task Lifetime

这里存在一个很容易忽略的问题。

如果 Agent Authorization：

```text
23:00 expires
```

但是 Agent 在：

```text
22:59
```

创建了一个：

```text
deadline = 1 hour
```

的任务，那么 Result 回来的时候 Agent 已经失去权限。

因此 Vault 应要求：

```text
taskDeadline
+
reviewWindow
<=
authorization.validUntil
```

或者更严格：

```text
full task lifecycle
必须落在 Agent authorization window 内
```

例如：

```text
Agent Session
─────────────────────────────
10:00                     22:00

Task
           ├───────────┤
          12:00       12:20

✓ valid
```

而：

```text
Session
─────────────────────────────
10:00                     22:00

Task
                         ├──────────────
                       21:59

✗ invalid
```

这样 Agent 创建任务时就能够确定：

> 自己拥有足够长的 authority 完成整个任务生命周期。

---

# 13. Vault 不提供 Arbitrary Execute

这是整个合约最重要的限制之一。

绝对不要提供：

```solidity
execute(
    address target,
    bytes calldata data
)
```

给 Agent。

否则：

```text
Agent
 ↓
execute(
  USDC,
  transfer(attacker, balance)
)
```

整个授权模型立即失去意义。

RequesterVault 应该只有：

> **semantic functions**

例如：

```text
createTask()

acceptResult()

rejectResult()

cancelTask()
```

而不是：

```text
arbitrary transaction execution
```

---

# 14. Vault 只连接可信 TaskManager

Agent 不能选择：

```text
taskManager address
```

否则攻击者可以：

```text
create fake TaskManager
↓
tell Vault to fund it
↓
drain funds
```

因此 MVP：

```text
RequesterVault
     │
     │ immutable / owner-approved
     ▼
TaskManager
```

TaskManager 地址应该：

```text
部署时确定
```

或者：

```text
只能由 Owner 修改
```

Agent 没有修改权限。

---

# 15. Settlement Token

Hackathon MVP：

```text
settlementToken = USDC
```

一个 RequesterVault 只管理一种 settlement token。

这样：

```text
deposit
budget
reward
settlement
```

全部使用统一单位。

Agent 不能自己决定：

```text
换成其他 ERC20

使用陌生 Token

使用 Native MON
```

未来可以扩展 multi-token。

但 MVP 固定 USDC 会明显降低攻击面和实现复杂度。

---

# 16. Deposit

Owner 调用：

```text
deposit(amount)
```

例如：

```text
Owner Wallet

100 USDC
   │
   │ deposit 50
   ▼
RequesterVault

50 USDC
```

此时：

```text
Owner retains ownership semantics
```

但这些资金已经成为：

> Agent Outsourcing Budget Pool。

---

# 17. Available Balance

Vault 可以暴露：

```text
availableBalance()
```

实际上可以直接基于：

```text
USDC.balanceOf(RequesterVault)
```

计算。

因为任务创建之后：

```text
reward
```

会被真实移动到：

```text
TaskManager escrow
```

而不是仅在 Vault 内部记账。

因此：

```text
Vault Balance
=
Currently Available Capital
```

这是非常清晰的 accounting model。

---

# 18. Task 创建时资金如何移动

完整交易：

```text
Agent Signer
      │
      ▼
RequesterVault.createTask()
      │
      ├── verify authorization
      │
      ├── verify spend limit
      │
      ├── committed += reward
      │
      ▼
transfer reward
      │
      ▼
TaskManager Escrow
      │
      ▼
Task Created
```

例如：

```text
Vault
50 USDC

Agent creates
1 USDC Task

↓

Vault
49 USDC

TaskManager Escrow
1 USDC
```

因此：

> **OPEN Task = Funded Task**

与 Protocol Design 保持一致。

---

# 19. 为什么资金直接进入 Escrow

不采用：

```text
Task exists
↓
Worker works
↓
then try to charge Requester
```

因为 Worker 在开始工作之前必须知道：

> 钱已经存在。

否则 Requester 可以：

```text
发布任务
↓
Agent 完成
↓
余额不足
↓
付款失败
```

所以：

```text
Task Creation
```

和：

```text
Reward Escrow
```

应该发生在同一笔原子交易里。

任何一步失败：

```text
整个交易 revert
```

---

# 20. RequesterVault 是唯一 Requester Authority

这是另一个重要设计。

Requester Agent **不应该直接调用**：

```text
TaskManager.acceptResult()
```

Requester 侧所有状态修改都经过 Vault：

```text
Agent
 ↓
RequesterVault
 ↓
TaskManager
```

因此：

```text
create
accept
reject
cancel
```

全部被 Policy Layer 控制。

---

# 21. 为什么必须经过 Vault

假设 Agent 被 Owner revoke：

```text
revokeAgent(agent)
```

如果 Agent 仍然可以直接调用：

```text
TaskManager.acceptResult()
```

那么 revoke 只阻止它创建新任务，却不能阻止它操作旧任务。

正确设计应该是：

```text
Agent
 ↓
RequesterVault
 ↓
is authorization active?
 ↓
yes → forward action
no  → reject
```

这样：

> **Revoke immediately removes economic authority.**

---

# 22. Task Operator Tracking

Vault 需要记录：

```text
taskId → operator
```

例如：

```text
Task #1024
operator = 0xAgent123
```

只有：

```text
task.operator
```

对应的 Agent 可以调用：

```text
acceptResult(taskId)

rejectResult(taskId)
```

避免 Agent A 操作 Agent B 创建的 Task。

---

# 23. Owner 始终拥有 Takeover 权限

即使 Agent：

```text
expired

revoked

offline
```

Owner 仍然需要能够处理现有任务。

因此：

```text
Owner
 ↓
RequesterVault
 ↓
acceptResult()

rejectResult()

cancel if allowed
```

Owner 是最终的：

> Requester Principal。

这也意味着：

```text
Agent authority
<
Owner authority
```

---

# 24. Revocation

Owner 可以调用：

```text
revokeAgent(agent)
```

效果：

```text
Agent can no longer:

createTask
acceptResult
rejectResult
cancelTask
```

但：

> 已经进入 Escrow 的 Task 不会被 Owner 自动拿回资金。

原因是 Worker 的权利也必须得到保护。

例如：

```text
Worker already claimed task
```

Owner 不能：

```text
revoke agent
↓
steal escrow back
```

Task 仍然按照 Protocol Lifecycle 运行。

Owner 只是在 Requester 侧接管管理责任。

---

# 25. Pause

RequesterVault 应拥有：

```text
pause()
```

Emergency Pause 后：

```text
Agent cannot create new Task

Agent cannot make privileged requester actions
```

Owner 可以继续：

```text
withdraw available funds

resolve existing Task
```

适用于：

```text
Agent key leaked

MCP server compromised

unexpected spending

TaskManager incident
```

---

# 26. Withdrawal

只有 Owner 可以调用：

```text
withdraw(amount)
```

并且只能提款：

```text
Vault 当前真实余额
```

已经转移到：

```text
Task Escrow
```

的资金不在 Vault 中，因此不能被 Withdraw。

例如：

```text
Vault balance      40 USDC
Escrow             10 USDC

Owner withdraw max:

40 USDC
```

而不是：

```text
50 USDC
```

这使 Worker 不会因为 Owner 提款而失去已锁定 Reward。

---

# 27. Agent Key 泄漏时的最大损失

假设：

```text
Vault Balance:           100 USDC

Agent Authorization:

maxPerTask:                2 USDC
maxTotalCommitment:       10 USDC
```

Agent Key 被攻击者获得。

攻击者即使：

```text
create malicious tasks

collude with workers

accept malicious results
```

最多可以动用：

```text
Remaining Session Commitment
```

例如：

```text
10 USDC
```

而不是：

```text
100 USDC
```

并且攻击者不能：

```text
withdraw remaining 90 USDC

transfer to arbitrary address

approve malicious contracts
```

这就是 RequesterVault 的核心价值。

---

# 28. 我们不声称阻止 Agent 主动作恶

需要明确安全边界。

如果 Owner 授权：

```text
Agent can spend 10 USDC
```

那么这个 Agent 本质上就拥有：

> 花掉这 10 USDC 的权限。

协议无法判断：

```text
Agent 是正常 outsource
```

还是：

```text
故意把任务交给自己的另一个地址
```

Sybil identity 也无法从钱包层解决。

因此 Wallet Layer 解决的是：

> **Bounded Authority**

而不是：

> **Perfect Agent Alignment**

---

# 29. Verification Authority

默认情况下：

```text
Task Operator
```

同时拥有：

```text
verify result
```

的权限。

即：

```text
Requester Agent
     │
     ├── create task
     │
     └── verify result
```

这最符合 Hackathon 的 Autonomous Agent Story。

未来可以分离：

```text
Requester Agent
      │
   create Task

Verifier Agent
      │
 verify Result
```

甚至 Owner 可以规定：

```text
任务金额 > 10 USDC
必须使用指定 Verifier
```

但 MVP 暂时不实现。

---

# 30. Gas Wallet

Agent Session Signer 需要发送 Monad transaction。

因此存在：

```text
USDC Budget
```

和：

```text
Gas Budget
```

两个不同概念。

MVP 最简单方案：

```text
Agent Session Signer
    │
    ├── tiny MON balance → gas
    │
    └── no USDC balance
```

USDC 始终保存在：

```text
RequesterVault
```

这已经比把全部资产交给 Agent 安全得多。

---

# 31. Gas Sponsorship

更完整的体验应该是：

```text
Agent
 ↓
sign intent
 ↓
Relayer / Sponsor
 ↓
Monad
```

这样 Agent 自身甚至不需要长期持有 MON。

Monad 当前支持 EIP-7702，并明确支持通过 EOA delegation 获得 gas sponsorship、alternative authentication、session keys 等 smart-account 能力。

但 Gas Sponsorship 不应该阻塞 Hackathon MVP。

因此：

```text
MVP
→ fund Agent Signer with small amount of MON

Later
→ sponsored transactions
```

---

# 32. 为什么 MVP 不直接基于 EIP-7702

EIP-7702 长期来看和我们的场景非常契合。

Monad 的实现允许现有 EOA delegate 到合约代码，从而获得 smart-wallet 类能力，包括：

```text
session keys

gas sponsorship

alternative authentication

transaction batching
```

而不需要用户迁移到新的 smart account。

理想未来：

```text
Owner EOA
   │
   │ EIP-7702 delegate
   ▼
Agent-aware Wallet Logic
   │
   ├── Session Agent A
   ├── Session Agent B
   └── Spending Policy
```

但第一版不应该依赖它。

---

# 33. Monad 7702 的特殊行为

Monad 上的 EIP-7702 和 Ethereum 大体相同，但官方文档指出两个重要差异：

1. delegated EOA 在涉及 MON balance 减少时受到 Monad 10 MON reserve-balance 规则约束；
2. delegated code 在 EOA context 下不能执行 `CREATE` / `CREATE2`。

因此如果 Hackathon MVP 直接把整个资金和 Agent 权限模型建立在 7702 上，会增加很多与核心 Story 无关的实现和 debugging 成本。

所以 v0.1：

> **RequesterVault first.**

7702：

> **Advanced Monad-native account model.**

---

# 34. Vault → 7702 的演进关系

两者其实使用的是同一个抽象：

```text
OWNER
  │
  ▼
POLICY
  │
  ▼
AGENT AUTHORITY
```

MVP：

```text
Owner EOA
   │
   ▼
RequesterVault
   │
   ▼
Agent Session Key
```

未来：

```text
Owner EOA
   │
EIP-7702
   │
   ▼
Delegated Account Logic
   │
   ▼
Agent Session Key
```

因此 Requester SDK 不应该强依赖：

```text
Vault implementation
```

而应该依赖更高层接口：

```text
RequesterAccount
```

---

# 35. RequesterAccount Interface

Requester SDK 可以抽象：

```ts
interface RequesterAccount {
  getBalance(): Promise<bigint>;

  getAuthorization(): Promise<AgentAuthorization>;

  getRemainingBudget(): Promise<bigint>;

  createTask(params: TaskParams): Promise<Task>;

  acceptResult(taskId: bigint): Promise<void>;

  rejectResult(
    taskId: bigint,
    reasonHash: Hex
  ): Promise<void>;
}
```

当前实现：

```text
VaultRequesterAccount
```

未来：

```text
EIP7702RequesterAccount
```

Requester Agent 不需要感知差异。

---

# 36. RequesterVault Contract Baseline

概念接口：

```solidity
interface IRequesterVault {

    function owner()
        external
        view
        returns (address);

    function settlementToken()
        external
        view
        returns (address);

    function taskManager()
        external
        view
        returns (address);

    function deposit(
        uint256 amount
    ) external;

    function withdraw(
        uint256 amount
    ) external;

    function authorizeAgent(
        address agent,
        AgentAuthorization calldata authorization
    ) external;

    function revokeAgent(
        address agent
    ) external;

    function createTask(
        TaskParams calldata params
    ) external returns (uint256 taskId);

    function acceptResult(
        uint256 taskId
    ) external;

    function rejectResult(
        uint256 taskId,
        bytes32 reasonHash
    ) external;

    function cancelTask(
        uint256 taskId
    ) external;

    function pause()
        external;

    function unpause()
        external;
}
```

---

# 37. Agent Authorization View API

为了 Requester Agent 能自主做经济决策，Vault 应提供：

```text
getAuthorization(agent)

getRemainingBudget(agent)

getAvailableBalance()
```

Agent 可以在 Outsourcing 前询问：

```text
My available budget:
7.4 USDC

Max per task:
2 USDC

Authorization expires:
5h 42m
```

然后决定：

```text
这个 subtask 是否值得花 0.8 USDC？
```

---

# 38. Requester SDK 使用体验

最终 Requester Agent 不应该操作底层合约字段。

SDK：

```ts
const requester =
  await createRequester({
    account: agentSigner,
    vault: vaultAddress
  });
```

获取 Budget：

```ts
const budget =
  await requester.getBudget();
```

返回：

```ts
{
  availableVaultBalance: "42.5",
  sessionLimit: "10",
  committed: "3.5",
  remaining: "6.5",
  maxPerTask: "2",
  expiresAt: "..."
}
```

Agent Hire：

```ts
await requester.hire({
  capability: "research.web",
  instructions: "...",
  reward: "0.8",
  deadline: "5m"
});
```

SDK 内部完成：

```text
policy check

TaskSpec creation

hashing

storage

Vault transaction
```

---

# 39. Owner Onboarding Flow

第一次使用：

```text
① Connect Wallet
        ↓
② Create Requester Vault
        ↓
③ Deposit USDC
        ↓
④ Agent generates Session Address
        ↓
⑤ Owner authorizes Agent
        ↓
⑥ Agent starts operating
```

UI 可以显示：

```text
Agent: Research Agent

Wallet:
0x72...a19

Budget:
10 USDC

Max Task:
2 USDC

Expires:
23h 59m

[ Revoke ]
```

---

# 40. Demo Wallet Story

Hackathon Demo 可以专门展示这个过程。

用户：

```text
Fund Agent
```

UI：

```text
Deposit
20 USDC
```

接着：

```text
Authorize Agent

Session Budget:    5 USDC
Max per Task:      2 USDC
Session Duration:  1 hour
```

Owner 签一次交易。

之后用户不再操作 Wallet。

Requester Agent 开始：

```text
Task A → 1 USDC

Task B → 1.5 USDC

Task C → 1 USDC
```

UI 实时显示：

```text
Agent Budget

5.0 USDC
↓
4.0
↓
2.5
↓
1.5
```

这个画面非常直接地表达：

> **The agent is autonomously spending its delegated budget.**

---

# 41. Agent 不需要 USDC Wallet

这里有一个容易混淆的地方。

Requester Agent 的：

```text
0xAgent...
```

不需要拥有：

```text
10 USDC
```

资金实际属于：

```text
RequesterVault
```

Agent Wallet 只是：

```text
authorization identity
```

所以：

```text
Agent Wallet ≠ Asset Wallet
```

Requester 侧更准确的模型是：

```text
Agent Identity
      +
Vault Capital
      +
Authorization Policy
```

三者共同组成：

> **Requester Account**

---

# 42. Worker Wallet 与 Requester Wallet 不同

Worker 模型简单很多：

```text
Worker Agent
     │
     ▼
Worker Wallet
     │
     ▼
receives USDC
```

Worker 是：

> payment recipient。

Requester 是：

> delegated spender。

因此不要强行让 Requester 和 Worker 共用完全相同的钱包抽象。

---

# 43. Security Invariants

RequesterWallet v0.1 必须满足：

### Invariant 1

Agent 永远不能调用：

```text
withdraw()
```

---

### Invariant 2

Agent 永远不能执行：

```text
arbitrary call
```

---

### Invariant 3

Agent 创建的单个 Task：

```text
reward <= maxPerTask
```

---

### Invariant 4

一个 Session 创建的累计任务：

```text
committed <= maxTotalCommitment
```

---

### Invariant 5

Agent 不能在：

```text
validUntil
```

之后执行 Requester privileged actions。

---

### Invariant 6

Agent 只能操作：

```text
自己创建的 Task
```

---

### Invariant 7

所有新 Task：

```text
创建时必须 fully funded
```

---

### Invariant 8

Owner revoke 后：

```text
Agent immediately loses Vault authority
```

---

### Invariant 9

Escrow 中的资金不能被 Owner Withdraw。

---

### Invariant 10

Agent 不可以自行修改：

```text
TaskManager

SettlementToken

Authorization Policy
```

---

# 44. Threat Model

## Agent key compromised

影响：

```text
Remaining authorized budget
```

缓解：

```text
maxPerTask

session limit

expiry

revoke

pause
```

---

## Agent runtime prompt injection

攻击者诱导 Agent：

```text
hire malicious worker
```

可能造成：

```text
authorized budget loss
```

但不能：

```text
withdraw vault
```

后续可以增加：

```text
Verifier

capability restriction

human approval threshold
```

---

## Malicious Worker

由：

```text
Verification Layer
```

处理。

Wallet Layer 不判断工作质量。

---

## Malicious TaskManager

TaskManager 是 protocol trust boundary。

因此 Vault 只允许连接：

```text
approved TaskManager
```

未来需要：

```text
audited / upgrade-controlled contract
```

---

## Owner key compromised

不属于 Agent Authorization Layer 可以解决的问题。

Owner 本身是 Root Authority。

---

# 45. 未来 Policy 能力

v0.1 只需要：

```text
maxPerTask

sessionLimit

expiry
```

未来可以扩展：

```text
allowedCapabilities

allowedWorkers

blockedWorkers

allowedVerifier

maxConcurrentTasks

hourlyLimit

dailyLimit

minimumVerificationLevel

requiredWorkerBond

humanApprovalAbove

geographical / compliance policy
```

例如：

```text
Agent 可以自主花：

≤ 2 USDC

2–10 USDC：
需要 Judge Agent

> 10 USDC：
需要 Human Approval
```

这可以逐渐演化成真正的：

> **Agent Financial Policy Engine**

---

# 46. 与 MCP / Skill 的关系

MCP 不应该暴露：

```text
sendTransaction

transferToken
```

而应该暴露：

```text
get_budget

hire_agent

accept_result

reject_result

get_task_status
```

这和 Vault 的 semantic interface 一一对应。

例如：

```text
LLM

"I want to outsource this."
        ↓
hire_agent
        ↓
Requester SDK
        ↓
RequesterVault
```

这样 Agent 的工具空间本身也是受约束的。

---

# 47. 与 Skill 的关系

Skill 的作用不是提供 Private Key。

Skill 负责教 Agent：

> **什么时候应该花钱。**

例如：

```text
Before outsourcing:

1. Check remaining budget.

2. Estimate whether delegation provides value.

3. Select an appropriate reward.

4. Make task requirements verifiable.

5. Never exceed economic value of the parent task.

6. Verify returned work before explicitly accepting.
```

因此：

```text
Vault
```

负责：

> hard financial limits。

而：

```text
Skill
```

负责：

> economic reasoning policy。

两者是互补关系。

---

# 48. Repo 模块关系

这一设计对应：

```text
contracts/
├── RequesterVault.sol
└── RequesterVaultFactory.sol   # optional

packages/
├── requester-sdk/
│   ├── account/
│   │   ├── RequesterAccount.ts
│   │   └── VaultRequesterAccount.ts
│   │
│   └── signer/
│       └── AgentSigner.ts
```

未来可以增加：

```text
EIP7702RequesterAccount.ts
```

而上层 Agent API 不需要发生变化。

---

# 49. MVP 实现范围

Hackathon 必须实现：

```text
RequesterVault

USDC Deposit

Agent Authorization

maxPerTask

maxTotalCommitment

authorization expiry

Agent createTask

Agent acceptResult

Agent rejectResult

Owner revoke

Owner withdraw

Owner emergency takeover
```

可以延后：

```text
EIP-7702 implementation

gas sponsorship

multiple tokens

policy scripting

daily rolling window

hardware key management

multisig Owner

social recovery
```

---

# 50. 本文锁定的设计决策

Requester Wallet v0.1 暂时锁定：

1. Owner 与 Agent Key 分离；
2. Agent 不持有 Owner 私钥；
3. Agent 使用独立 Session Signer；
4. USDC 保存在 RequesterVault；
5. Vault 使用固定 TaskManager；
6. Vault 使用固定 settlement token；
7. Agent 没有 arbitrary execution；
8. Agent 权限由 maxPerTask、session limit、expiry 限制；
9. Budget 统计采用 cumulative commitment；
10. Task 创建时 Reward 立即进入 Escrow；
11. Requester 侧 Task 操作全部经过 Vault；
12. Owner 可以 revoke 和 emergency takeover；
13. Agent Session 的有效期必须覆盖 Task 生命周期；
14. MVP Gas 由 Agent Signer 持有少量 MON；
15. EIP-7702 作为后续 Monad-native Account Extension。

---

# 51. 最终抽象

Requester 侧不是：

```text
AI
+
Private Key
```

而是：

```text
           OWNER CAPITAL
                │
                ▼
        ┌────────────────┐
        │ RequesterVault │
        └───────┬────────┘
                │
            POLICY
                │
                ▼
        ┌────────────────┐
        │ Agent Session  │
        └───────┬────────┘
                │
         economic actions
                │
                ▼
          Task Protocol
```

Owner 提供：

> **Capital**

Vault 提供：

> **Boundaries**

Agent 提供：

> **Decision Making**

Monad 提供：

> **Enforcement**

最终我们得到的不是一个：

> “AI 有一个 Wallet”

而是一个更重要的 primitive：

> **An AI agent with bounded economic authority.**

这也是整个 Agent Task Network 能够真正自主运行的前提。
