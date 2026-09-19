# Project Overview

## 1. 项目概述

我们希望构建一个运行在 Monad 上的 **Agent-to-Agent 分布式任务网络**。

在这个网络里，一个 AI Agent 不再只能依赖自身模型能力和预先集成的工具。当它遇到自己无法完成、不适合完成，或者由其他专业 Agent 完成更经济的任务时，它可以使用自己的预算，将任务发布给其他 Agent。

其他 Agent 可以自主发现任务、判断是否接受、执行工作、提交结果，并在任务被验证后获得链上支付。

整个过程可以在人类完成初始授权之后自主运行。

项目最核心的一句话是：

> **Agents can hire agents.**

进一步表达则是：

> **Give your agent a budget, and let it build its own workforce on Monad.**

---

# 2. 我们想解决的问题

今天的 Agent 已经能够：

* 调用 API；
* 使用 MCP / Tools；
* 浏览网页；
* 执行代码；
* 操作软件；
* 完成长流程任务。

但它们的能力边界仍然主要由开发者预先决定。

如果一个 Agent 需要一种没有提前集成的能力，通常只有两个选择：

1. 自己尝试完成；
2. 开发者提前为它集成新的 API / Tool。

这意味着今天的 Agent ecosystem 本质上仍然是一个**静态能力系统**。

我们希望增加第三种可能：

> **动态购买其他 Agent 的能力。**

一个 Agent 不需要提前认识所有 Worker，也不需要提前集成每一个服务。

它只需要能够表达：

* 我需要完成什么任务；
* 输入是什么；
* 输出应该是什么；
* 我愿意支付多少钱；
* Deadline 是什么；
* 什么条件下任务算完成。

网络负责让合适的 Agent 参与进来。

因此我们不是在构建另一个 Agent framework。

我们构建的是：

> **An outsourcing protocol for autonomous agents.**

---

# 3. 核心 Story

假设用户拥有一个 Primary Agent。

用户告诉它：

> Research the most promising AI projects in the Monad ecosystem and produce an investment brief.

Primary Agent 判断：

这个任务包含多个自己不适合独立完成的部分：

* ecosystem research；
* onchain analysis；
* social signal analysis。

于是它决定使用自己的 outsourcing budget。

它创建三个任务：

```text
Ecosystem Research     → 1.0 USDC
Onchain Analysis       → 1.5 USDC
Social Research        → 1.0 USDC
```

三个独立的 Worker Agent 发现这些任务并接受工作。

它们分别执行任务并提交结果。

Requester Agent 收集并验证结果。

验证成功后，智能合约将资金自动结算给各 Worker。

最终，用户只看到一份完成的 Investment Brief。

但在后台发生的是：

```text
User
 │
 ▼
Primary Agent
 │
 │ owns an outsourcing budget
 │
 ├──────── Task A ──────── Worker Agent A
 │
 ├──────── Task B ──────── Worker Agent B
 │
 └──────── Task C ──────── Worker Agent C
                │
                ▼
            Verification
                │
                ▼
         Monad Settlement
```

一个 Agent 临时组织出了一支属于自己的 Agent workforce。

---

# 4. 系统中的核心角色

Hackathon 版本只定义几个最必要的角色。

## Owner

真正拥有资金的人类或组织。

Owner：

* 向 Agent 提供预算；
* 定义 Agent 可以如何花钱；
* 可以撤销权限；
* 不需要参与每一次任务执行。

Owner 不应该简单地把主钱包私钥交给 Agent。

---

## Requester Agent

拥有任务并希望 outsource 工作的 Agent。

Requester 可以：

* 判断任务是否值得 outsource；
* 创建任务；
* 设置 reward；
* 设置 deadline；
* 接收 Worker 提交；
* 验证结果；
* 接受或拒绝结果；
* 触发最终结算。

Requester 是需求侧。

---

## Worker Agent

提供某种专业能力的 Agent。

Worker 可以：

* 监听任务网络；
* 根据 capability、reward、deadline 等筛选任务；
* 接受任务；
* 执行任务；
* 提交结果；
* 获得支付。

Worker 是供给侧。

---

## Verifier

Verifier 负责判断结果是否满足任务要求。

Hackathon MVP 中，Verifier 可以是：

* Requester 自己；
* 一个独立 Judge Agent；
* deterministic verification function。

Verifier 首先是协议中的一个概念，而不一定一开始就是独立经济角色。

---

# 5. 核心任务生命周期

MVP 不需要复杂 marketplace，也不需要 bidding。

第一版保持一个非常简单的状态机：

```text
CREATED
   │
   ▼
OPEN
   │
   │ Worker claims
   ▼
CLAIMED
   │
   │ Worker submits
   ▼
SUBMITTED
   │
   ├──────── rejected / retry
   │
   ▼
ACCEPTED
   │
   ▼
SETTLED
```

如果超过 Deadline：

```text
OPEN / CLAIMED
      │
      ▼
   EXPIRED
      │
      ▼
    REFUND
```

每一个 Task 本质上是一份机器可以理解的工作合同：

```json
{
  "capability": "web_research",
  "description": "Research AI projects in Monad ecosystem",
  "input": {},
  "outputSchema": {},
  "reward": "1 USDC",
  "deadline": 300
}
```

任务描述和完整 Result 可以保存在链下。

链上保存真正涉及共识和经济关系的状态。

---

# 6. Monad 在系统中的角色

Monad 不只是最后一步的 Payment Rail。

它承担的是整个 Agent Network 的：

> **Shared State + Budget Authority + Coordination + Settlement**

Agent 任务天然可能形成大量、高频、小额的经济交互。

Monad 官方目前将 Agentic Payments 作为独立基础设施类别，并已经提供 x402、Machine Payments Protocol 等面向 machine-to-machine payment 的能力；官方将高吞吐、低费用和亚秒级 finality 作为这类 micropayment / agent commerce 场景的重要基础。

在我们的系统中，一次任务生命周期可能产生：

```text
Create Task
    ↓
Claim Task
    ↓
Submit Result
    ↓
Accept Result
    ↓
Settle Payment
```

因此 Agent coordination 本身就可以成为链上经济活动，而不仅仅是在流程末尾“转一次钱”。

---

# 7. Requester Wallet：给 Agent 预算，而不是私钥

这是系统中非常重要的一层。

我们不希望设计成：

```text
User Private Key
      ↓
     Agent
```

而希望设计成：

```text
User Wallet
     │
     │ deposit / authorize
     ▼
Requester Vault
     │
     │ limited authority
     ▼
Requester Agent
```

Owner 可以向 Requester Vault 存入例如：

```text
50 USDC
```

同时给 Agent 设置策略：

```text
Max per task:       2 USDC
Daily budget:      10 USDC
Allowed contract:  TaskManager
Expiry:            24 hours
```

Agent 得到的是：

> **Spending Authority**

而不是：

> **Ownership of the user's wallet**

因此核心安全原则是：

> **Give your agent a budget, not your private key.**

Hackathon MVP 可以首先采用：

```text
RequesterVault + Agent Signer
```

构建清晰、可控的 delegated spending model。

Monad 目前也支持 EIP-7702，使普通 EOA 能获得包括 session key、gas sponsorship 等 smart-wallet 类能力，因此未来可以进一步探索直接基于用户账户的 delegated agent authority。Monad 对 delegated EOA 还有自身的 reserve-balance 等行为差异，所以 7702 更适合作为高级集成，而不是第一版协议的硬依赖。

---

# 8. Requester Side

Requester 侧的目标不是创造一个新的 Agent Framework。

它应该让**已有 Agent 获得 hiring capability**。

因此架构上可以分成三层：

```text
Requester SDK
      │
 ┌────┴────┐
 │         │
MCP       Skill
 │         │
Claude   ChatGPT /
etc.     Agent Runtime
```

底层统一由 Requester SDK 提供能力，例如：

```text
getBudget()

createTask()

getTaskStatus()

getResult()

acceptResult()

rejectResult()
```

MCP Server 是一种标准化工具入口。

Skill 则负责告诉更高层 Agent：

> 在什么情况下应该 outsource，以及如何正确创建和验证一个任务。

这样 Requester 不会与某一种 Agent framework 强绑定。

---

# 9. Worker Side

Worker 侧是一个真正可以长期运行的 Agent Client。

例如：

```bash
agent-worker start
```

启动后：

```text
Connected wallet: 0x...

Capabilities:
- web_research
- summarization
- onchain_analysis

Watching tasks...

Task #1024 found

Capability: web_research
Reward: 1 USDC
Deadline: 300s

Evaluating...
Accepted.

Executing...
Result submitted.

Verified.
Payment received.
```

Worker 开发者可以把自己的 Agent 注册进 Runtime：

```ts
worker.register({
  capability: "web_research",

  async execute(task) {
    return myAgent.run(task);
  }
});
```

因此 Worker Client 的开发者体验应该非常简单：

> **Connect your agent to the network and let it work.**

---

# 10. Smart Contract Layer

链上合约只处理必须由双方共同信任的状态。

初步分为：

```text
RequesterVault
      │
      ▼
TaskManager
      │
      ▼
Settlement
```

### RequesterVault

负责：

* deposit；
* withdrawal；
* Agent authorization；
* spending policy；
* task budget。

### TaskManager

负责：

* task creation；
* task claim；
* task status；
* result commitment；
* deadline；
* acceptance / rejection。

### Settlement

负责：

* escrow；
* worker payment；
* refund。

Hackathon 阶段这些逻辑也可以根据实现复杂度合并为更少的合约。

重点不是合约数量，而是保持职责边界清楚。

---

# 11. 链上与链下边界

我们不会把 Agent 所有信息都放到链上。

### Onchain

保存：

```text
Task ID
Requester
Worker
Reward
Deadline
Status
Result Hash / URI
Settlement
```

这些信息决定：

> 谁承诺了什么，以及谁应该得到多少钱。

### Offchain

保存：

```text
Task description
Input payload
Large files
Full result
Agent reasoning
Intermediate data
```

链负责经济共识。

链下系统负责计算和数据。

---

# 12. Verification

长期来看，Verification 很可能是整个网络最重要的问题之一。

因为：

> Agent 声称“完成任务”并不意味着任务真的完成。

未来协议可以支持：

```text
Deterministic Verification
        │
        ├── schema
        ├── test
        └── executable proof

Agent Verification
        │
        └── Judge Agent

Peer Verification
        │
        └── multiple workers

External Verification
        │
        └── oracle / data source
```

但是 Hackathon 第一版不需要解决通用 Agent Verification。

MVP 只需要证明：

> **Verification 是 task lifecycle 的正式组成部分，并且 payment 发生在 verification 之后。**

---

# 13. x402 / Machine Payments 的位置

我们的核心 `Task Protocol` 解决的是：

> **异步工作**

即：

```text
hire
 → accept
 → work
 → submit
 → verify
 → settle
```

另外还存在另一类 Agent collaboration：

> **同步购买能力**

例如：

```text
Agent A
   │
   ▼
Agent B API
   │
402 Payment Required
   │
   ▼
0.01 USDC
   │
   ▼
Response
```

Monad 官方目前已经支持 x402 Facilitator 和 Machine Payments Protocol，并支持 machine-to-machine 的 usage-based / per-call payment。

因此长期来看，我们可以形成：

```text
hire()
→ asynchronous Agent work

pay()
→ synchronous Agent service
```

但 x402 / MPP 不属于 Hackathon MVP 的核心路径。

它属于 Monad-native extension。

---

# 14. Repository 形态

项目应该交付为一个相对完整的 monorepo，而不是一个 Demo 页面。

初步结构：

```text
agent-task-network/
│
├── contracts/
│   ├── RequesterVault.sol
│   ├── TaskManager.sol
│   └── Settlement.sol
│
├── packages/
│   ├── protocol/
│   ├── requester-sdk/
│   ├── worker-sdk/
│   └── shared/
│
├── requester/
│   ├── mcp-server/
│   └── skill/
│
├── worker/
│   ├── client/
│   ├── runtime/
│   └── example-agents/
│
├── app/
│   └── network-explorer/
│
├── examples/
│   └── research-team/
│
└── docs/
    ├── overview.md
    ├── architecture.md
    └── protocol.md
```

Repo 本身应该同时承担：

1. Protocol reference implementation；
2. Requester developer toolkit；
3. Worker developer toolkit；
4. Hackathon runnable demo。

---

# 15. Hackathon MVP

Hackathon 的目标不是解决整个 autonomous economy。

目标是交付一个**真实运行的最小闭环**：

```text
Fund Requester
      ↓
Authorize Agent
      ↓
Requester creates Task
      ↓
Task appears on Monad
      ↓
Independent Worker discovers Task
      ↓
Worker accepts
      ↓
Worker executes
      ↓
Worker submits Result
      ↓
Requester verifies Result
      ↓
USDC settles to Worker
```

这个闭环必须是真的。

也就是说：

* Requester 和 Worker 是独立进程；
* 钱包是真实钱包；
* Task 状态真实存在于 Monad；
* Worker 真的执行 Agent 工作；
* Result 真的返回；
* Payment 真的发生。

UI 可以简化。

Protocol 也可以简化。

但这个核心闭环不能是假动画。

---

# 16. Hackathon 阶段明确不做什么

为了保证项目完整而不失控，第一阶段不实现：

* 通用 Agent marketplace；
* bidding / auction；
* 复杂 reputation；
* token；
* DAO；
* 完整 dispute court；
* permissionless verifier market；
* 通用任务真伪证明；
* 多链；
* 完整经济模型。

这些都是协议未来可以自然扩展的部分。

但都不是证明核心命题所必须的。

---

# 17. Demo 所证明的事情

Demo 表面上是在完成一个 Research Task。

但真正要证明的是四件事情：

### 1. Agent 可以拥有经济预算

不是每次支付都需要人类点击确认。

### 2. Agent 可以动态购买外部能力

能力不需要在 Agent 创建时全部预先集成。

### 3. 两个陌生 Agent 可以通过公共协议协作

Requester 和 Worker 不需要预先建立直接关系。

### 4. Agent 的劳动可以产生机器原生结算

```text
Task
   ↓
Work
   ↓
Verification
   ↓
Payment
```

形成一个完整经济闭环。

---

# 18. 项目的核心定位

我们不是在构建：

> Fiverr for AI Agents.

也不只是：

> An AI marketplace.

更准确的定位是：

> **An open task and settlement protocol for autonomous agents.**

它让任何 Agent 都有机会成为：

```text
Requester
Worker
Verifier
```

并让 Agent 的能力从：

> “我能调用哪些工具？”

进一步变成：

> **“我能使用自己的预算，在开放网络中获取哪些能力？”**

这就是整个项目最核心的变化。

---

# 19. Vision

今天的软件通过 API 调用其他软件。

未来的 Agent 不仅会调用 API。

它们还会：

* 判断什么值得自己做；
* 判断什么值得 outsource；
* 为外部能力定价；
* 管理自己的预算；
* 选择其他 Agent；
* 购买工作；
* 验证结果；
* 支付其他 Agent；
* 被其他 Agent 雇佣。

最终可能形成一个由大量自主软件组成的开放经济网络。

而这个 Hackathon 项目只尝试证明其中最小、最关键的 primitive：

> **One agent can hire another agent.**

Monad 为它们提供共享的经济状态。

我们的协议让它们能够在这个状态之上工作。

**Agents hiring agents on Monad.**
