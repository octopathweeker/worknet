# Requester MCP & Skill Design

## 1. 文档目的

本文定义 Requester Agent 如何真正获得：

> **Hire another agent**

这一能力。

前面的 Requester SDK 已经能够：

```text
create task
wait for result
accept / reject
manage budget
```

但 SDK 本身只是 TypeScript API。

真实世界中的 Agent Runtime 可能来自：

```text
ChatGPT
Claude
Claude Code
Cursor
Custom Agent Runtime
OpenAI Agents
Other MCP-compatible hosts
```

因此我们需要两个不同层次的组件：

```text
Requester SDK
     │
     ├──────── MCP Server
     │           │
     │           ▼
     │      executable tools
     │
     └──────── Skill
                 │
                 ▼
          delegation policy
```

它们解决两个完全不同的问题：

> **MCP 决定 Agent 能做什么。**

> **Skill 决定 Agent 什么时候应该这么做。**

这是本文最重要的设计原则。

---

# 2. 三层职责

整个 Requester Agent Stack 应明确拆成：

```text
┌──────────────────────────────┐
│            Skill             │
│                              │
│  Should I outsource?         │
│  How should I split it?      │
│  How much should I spend?    │
│  Should I accept result?     │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│          MCP Server          │
│                              │
│  get_budget                  │
│  hire_agent                  │
│  get_task                    │
│  accept_result               │
│  reject_result               │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│        Requester SDK         │
│                              │
│  TaskSpec                    │
│  Storage                     │
│  Wallet                      │
│  Monad                       │
└──────────────────────────────┘
```

再往下才是：

```text
RequesterVault
TaskManager
Monad
```

---

# 3. 为什么 MCP 和 Skill 不能混在一起

如果所有逻辑都放进 MCP：

```text
hire_agent()
```

只是一个工具。

Agent 并不知道：

```text
什么时候该调用？

任务应该怎么拆？

什么任务不应该 outsource？

Reward 应该是多少？

什么 Result 可以接受？
```

反过来，如果只有 Skill：

```text
“当适合时雇佣其他 Agent”
```

但没有工具，

Agent 实际上什么都做不了。

因此：

```text
Skill
=
Decision Policy
```

```text
MCP
=
Execution Surface
```

```text
SDK
=
Protocol Implementation
```

```text
Vault
=
Security Enforcement
```

这四层必须分离。

---

# 4. 当前 MCP 基线

Requester MCP Server 建议以当前稳定的 MCP `2026-07-28` specification 为基线。

这一版本已经采用 stateless protocol core，并提供正式 extension framework；官方 TypeScript SDK v2 也是对应 `2026-07-28` spec 的稳定版本。

这与我们的架构非常契合。

因为真正持久的经济状态本来就不应该存在 MCP Session 内：

```text
MCP Server
     │
     │ stateless adapter
     ▼
Requester SDK
     │
     ▼
Monad
```

即使：

```text
MCP Server restart
```

也不会丢失：

```text
Task
Budget
Worker
Submission
Settlement
```

因为这些状态可以从 Monad 和 Storage 重建。

---

# 5. MCP Server 定位

Requester MCP Server 不是钱包。

不是 Agent。

也不是 Task Backend。

它只是：

> **A capability adapter between an Agent runtime and the Requester SDK.**

目录：

```text
requester/
└── mcp-server/
    ├── src/
    │   ├── server.ts
    │   ├── tools/
    │   ├── resources/
    │   ├── auth/
    │   └── config/
    └── package.json
```

内部：

```text
MCP Tool
   ↓
Requester SDK
   ↓
RequesterAccount
   ↓
RequesterVault
   ↓
Monad
```

---

# 6. MCP Tool Surface

第一版只暴露少量 semantic tools：

```text
get_budget

hire_agent

get_task

list_tasks

get_submission

accept_result

reject_result

cancel_task
```

不要暴露：

```text
send_transaction

call_contract

transfer_token

sign_arbitrary_message

execute_calldata
```

这延续 RequesterVault 的安全原则：

> **Give the Agent semantic economic capabilities, not arbitrary wallet access.**

---

# 7. get_budget

这是 Agent 在做任何经济决定之前最重要的工具。

输入：

```json
{}
```

输出：

```json
{
  "vaultBalance": "42.5 USDC",
  "sessionLimit": "10 USDC",
  "committed": "3.5 USDC",
  "remaining": "6.5 USDC",
  "maxPerTask": "2 USDC",
  "expiresAt": "2026-09-19T10:00:00Z",
  "active": true
}
```

Agent 应该能够直接理解：

> 我还能花多少钱。

这是一个：

```text
read-only
```

操作。

---

# 8. hire_agent

这是整个 Requester Stack 最核心的 MCP Tool。

语义不是：

> “转钱。”

而是：

> **Create a funded economic request for another agent to perform work.**

输入概念：

```json
{
  "capability": "research.web",

  "title": "Research Monad AI projects",

  "instructions": "Find notable AI projects in the Monad ecosystem.",

  "input": {
    "maxProjects": 5
  },

  "outputSchema": {
    "type": "object"
  },

  "acceptanceCriteria": [
    "at least 5 projects",
    "each project contains source references"
  ],

  "reward": "1 USDC",

  "deadline": "5m",

  "clientRequestId": "research-parent-42-part-a"
}
```

返回：

```json
{
  "taskId": "1024",

  "status": "OPEN",

  "reward": "1 USDC",

  "transactionHash": "0x...",

  "deadline": "...",

  "specHash": "0x..."
}
```

---

# 9. clientRequestId

MCP Tool 调用尤其需要：

```text
clientRequestId
```

因为 Agent Runtime 可能因为：

```text
timeout
retry
connection interruption
model retry
```

重复发起工具调用。

如果：

```text
hire_agent
```

每次调用都创建新 Task，

就可能发生：

```text
Agent intended to spend 1 USDC

↓

network timeout

↓

retry

↓

2 USDC committed
```

因此：

```text
clientRequestId
```

必须映射到 Requester SDK 的：

```text
idempotencyKey
```

同一个请求重复调用：

```text
返回原 Task
```

而不是：

```text
创建第二个 Task
```

---

# 10. get_task

输入：

```json
{
  "taskId": "1024"
}
```

返回：

```json
{
  "taskId": "1024",

  "status": "CLAIMED",

  "worker": "0x...",

  "reward": "1 USDC",

  "createdAt": "...",

  "deadline": "...",

  "claimLeaseExpiresAt": "...",

  "hasSubmission": false
}
```

这是 Agent 查询：

> “我雇的人做到哪一步了？”

的基础工具。

---

# 11. list_tasks

用于 Agent Runtime 重启后的恢复。

例如：

```json
{
  "statuses": [
    "OPEN",
    "CLAIMED",
    "SUBMITTED"
  ]
}
```

返回：

```json
{
  "tasks": [
    {
      "taskId": "1024",
      "status": "SUBMITTED"
    },
    {
      "taskId": "1025",
      "status": "CLAIMED"
    }
  ]
}
```

Agent 不应该依赖自己的 Conversation Memory 记住 Task。

经济状态应该从 Protocol 恢复。

---

# 12. get_submission

当：

```text
status = SUBMITTED
```

Agent 调用：

```text
get_submission
```

输入：

```json
{
  "taskId": "1024"
}
```

输出：

```json
{
  "taskId": "1024",

  "worker": "0xWorker",

  "result": {
    "projects": [],
    "summary": "..."
  },

  "validation": {
    "hashValid": true,
    "schemaValid": true,
    "errors": []
  },

  "submittedAt": "...",

  "reviewDeadline": "..."
}
```

Requester SDK 已经完成：

```text
result fetch

resultHash verification

schema validation
```

Agent 主要负责：

> semantic verification。

---

# 13. accept_result

只有 Agent 认为 Result 满足 TaskSpec 后调用。

输入：

```json
{
  "taskId": "1024"
}
```

返回：

```json
{
  "taskId": "1024",
  "status": "SETTLED",
  "worker": "0x...",
  "amount": "1 USDC",
  "transactionHash": "0x..."
}
```

这是真正产生：

```text
Worker Payment
```

的经济操作。

因此 Skill 必须明确：

> **Never accept a result before inspecting the submission.**

---

# 14. reject_result

输入：

```json
{
  "taskId": "1024",

  "reason": "Missing required source references"
}
```

内部：

```text
reason
 ↓
canonical representation
 ↓
reasonHash
 ↓
Requester SDK
```

返回：

```json
{
  "taskId": "1024",
  "status": "OPEN"
}
```

Task 回到 Worker Network。

Agent 可以等待新的 Worker。

---

# 15. cancel_task

仅允许：

```text
OPEN
```

状态。

输入：

```json
{
  "taskId": "1024"
}
```

典型情况：

```text
Parent task cancelled

Task no longer useful

User changed goal
```

Agent 不应该把 cancel 当成：

> “Worker 做了一半我不想付钱了。”

Protocol 本身会阻止已经：

```text
CLAIMED
```

的 Task 被随意 Cancel。

---

# 16. 不建议 MVP 暴露 wait_for_result

之前我们设想：

```text
wait_for_result()
```

作为 MCP Tool。

现在建议把 v0.1 Core Tool Surface 稍微收紧。

优先采用：

```text
get_task()
```

*

```text
get_submission()
```

因为：

```text
wait 5 minutes
```

的长期 blocking Tool Call 会增加不同 MCP Host 的兼容复杂度。

当前 MCP `2026-07-28` 已经提供 extensions framework，并包含面向 long-running work 的 Tasks extension，因此未来可以让等待行为使用 MCP Tasks，而不是自己设计一个长期阻塞调用。

所以：

```text
Core v0.1

get_task()
get_submission()
```

未来：

```text
MCP Tasks integration
```

用于：

```text
wait_for_result
```

---

# 17. 两种 Task 不要混淆

这里存在两个不同的 Task 概念：

### Agent Network Task

```text
Monad Task #1024
```

代表：

> 一份有资金、有 Worker、有 Result、有 Settlement 的经济任务。

### MCP Task

代表：

> MCP 层一个 asynchronous / long-running operation。

两者不能混为一谈。

可以理解成：

```text
MCP Task
     │
     │ waits for
     ▼
Agent Network Task
```

经济 source of truth 始终是：

```text
Monad Task
```

---

# 18. MCP Resources

MCP 还支持 Resources，用来向 Client 提供结构化 context；Resources 与 Tools 的职责本来就不同——Tools 用于模型执行动作，而 Resources 更适合作为应用提供的上下文。

因此我们可以提供可选 Resources：

```text
agentnet://budget

agentnet://tasks

agentnet://tasks/1024

agentnet://capabilities
```

例如：

```text
agentnet://budget
```

返回：

```text
Remaining Budget: 6.5 USDC
Max Per Task: 2 USDC
Expires: 5h 42m
```

但 Resources 是 convenience。

核心 Agent 行为不能依赖 Host 一定会把 Resource 放进 Context。

因此关键操作仍然通过 Tools。

---

# 19. MCP Prompts

MCP 支持 Prompt primitive，

但我们不应该把主要 Delegation Policy 放在 MCP Prompt 中。

原因是：

```text
Prompt
```

通常需要 Host / User 主动选择和调用。

我们的目标是：

> Agent 自主判断什么时候 outsource。

所以：

```text
Delegation Policy
```

更适合进入：

```text
Requester Skill
```

而不是依赖：

```text
MCP Prompt
```

---

# 20. MCP Server 本身没有资金权限

这里非常重要。

MCP Server 不应该：

```text
持有 Owner Wallet Private Key
```

它只能访问：

```text
Agent Session Signer
```

而 Agent Session Signer 的权限又受到：

```text
RequesterVault
```

限制。

完整安全链：

```text
LLM
 │
 ▼
MCP Tool
 │
 ▼
Requester SDK
 │
 ▼
Agent Session Signer
 │
 ▼
RequesterVault
 │
 │ hard policy
 ▼
TaskManager
```

即使 MCP Server 被攻陷：

攻击面仍然受：

```text
maxPerTask

sessionLimit

expiry
```

限制。

---

# 21. Skill 的核心职责

Requester Skill 不是 SDK 文档。

它不应该告诉 Agent：

```text
调用哪个 Solidity ABI

怎么计算 keccak256

USDC 有多少 decimals
```

这些已经属于 SDK。

Skill 只需要教 Agent：

```text
WHEN to delegate

WHAT to delegate

HOW to specify the task

HOW MUCH to spend

HOW to evaluate returned work
```

---

# 22. Skill 的基本心智模型

Skill 应该让 Agent 使用如下思路：

```text
Receive Parent Task
       │
       ▼
Can / should I do this myself?
       │
   ┌───┴────┐
   │        │
 yes       no / inefficient
   │        │
 local      ▼
 work   Can it be delegated
        as a verifiable task?
              │
          ┌───┴───┐
          │       │
         no      yes
          │       │
        local     ▼
                budget?
                  │
                  ▼
                 hire
```

关键不是：

> “任何任务都 outsource。”

而是：

> **Selective delegation.**

---

# 23. Delegation Conditions

Agent 应优先考虑 Outsource：

### Capability Gap

自己缺乏某项专业能力。

例如：

```text
onchain analysis
specific data access
specialized research
```

---

### Parallelism

多个相互独立的工作可以同时完成。

例如：

```text
Research Market A

Research Market B

Research Market C
```

---

### Economic Efficiency

外部 Worker：

```text
cost < expected value
```

---

### Latency

其他 Agent 可以显著降低 Parent Task 完成时间。

---

### Specialization

专用 Worker 很可能比 General Agent 有更高质量。

---

# 24. 不应该 Delegation 的情况

Skill 应明确禁止一些情况。

### Trivial Work

如果调用网络的协调成本已经高于任务本身：

```text
不要 outsource
```

---

### Unverifiable Work

如果 Requester 完全无法判断结果是否正确：

```text
不要自动支付
```

至少应该增加 Verifier。

---

### Sensitive Information

v0.1 默认 TaskSpec 是公开的。

因此：

> **Do not publish secrets, credentials, private user data, or confidential content into a public Task.**

这个规则必须进入 Skill。

不能因为 Agent 想 outsource：

```text
把整个用户 Conversation
```

直接发布到公开 TaskSpec。

---

### Insufficient Budget

如果：

```text
remaining budget < reward
```

不要通过奇怪的重试尝试绕过 Policy。

---

### Deadline Mismatch

如果网络 Task 不可能在 Parent Deadline 前完成：

```text
do locally
```

或者选择其他策略。

---

# 25. Subtask Authoring

Skill 最重要的能力之一其实是：

> **写好一份别人能完成的 Task。**

一个好的 Subtask 应包括：

```text
Objective

Necessary Context

Inputs

Expected Output

Acceptance Criteria

Deadline
```

不要写：

```text
Help me with this.
```

应该写：

```text
Find 5 AI-related projects currently building
in the Monad ecosystem.

For each project return:

- project name
- URL
- one-paragraph description
- source references

Do not include projects without a verifiable source.
```

这样 Task 才有可能被 Worker 执行和验证。

---

# 26. Context Minimization

Requester Agent 不应该把整个 Parent Context 都传给 Worker。

应该执行：

```text
Parent Context
      │
      ▼
Extract minimum required context
      │
      ▼
Subtask
```

这有三个好处：

```text
降低隐私风险

降低 Worker token cost

减少 Prompt contamination
```

因此 Skill 中应该明确：

> **Pass only the information necessary to complete the delegated task.**

---

# 27. Acceptance Criteria

每个 Task 尽可能定义机器或 Agent 可以检查的标准。

例如不要只写：

```text
Write a good report.
```

而是：

```text
Return JSON containing:

projects[]
summary

projects.length >= 5

Each project must include:
name
url
description
sources[]
```

这样：

```text
Worker
Requester
Verifier
```

对“完成”有相对一致的理解。

---

# 28. Reward Selection

Hackathon v0.1 不做自动 marketplace pricing。

Skill 可以使用简单策略：

```text
Reward must:

1. fit maxPerTask

2. fit remaining budget

3. be lower than expected value
   of delegation

4. reflect rough complexity
```

第一版甚至可以使用 Capability 默认价格：

```text
research.web       1.0 USDC

analysis.onchain   1.5 USDC

summarization      0.5 USDC
```

这些属于：

```text
demo configuration
```

而不是协议标准。

---

# 29. 禁止无限自动加价

如果没有 Worker 接单，

Skill 不应该：

```text
1 USDC
↓
2 USDC
↓
4 USDC
↓
8 USDC
...
```

自动不断提高 Reward。

MVP 默认规则：

> **Never automatically increase reward unless an explicit retry policy has been configured.**

否则 Autonomous Agent 很容易产生不可预测的消费行为。

---

# 30. Result Evaluation

当：

```text
SUBMITTED
```

之后，

Skill 应执行：

```text
1. get_submission

2. inspect validation

3. compare result to acceptance criteria

4. check major factual / structural requirements

5. accept or reject
```

Agent 不应因为：

```text
worker submitted something
```

就调用：

```text
accept_result
```

---

# 31. Reject 必须提供理由

如果 Result 不符合要求：

```text
reject_result
```

最好给出：

```text
specific reason
```

例如：

```text
Missing source references for 3 projects.
```

而不是：

```text
bad result
```

这个 Reason 可以：

```text
帮助下一个 Worker理解问题

帮助 Explorer 展示生命周期

未来形成 Worker quality data
```

---

# 32. Result Retry

如果 Task 被 Reject：

```text
SUBMITTED
 ↓
REJECT
 ↓
OPEN
```

Skill 可以继续等待其他 Worker，

而不需要创建一个新的 Task。

因为原 Reward：

```text
仍然在 Escrow
```

这比重新：

```text
hire_agent()
```

更经济，也避免重复 commitment。

---

# 33. Multi-Agent Delegation

Parent Agent 可以并行创建：

```text
Task A

Task B

Task C
```

例如：

```text
                Primary Agent
                 /     |     \
                /      |      \
               ▼       ▼       ▼
          Research  Onchain  Social
```

Skill 应优先寻找：

> **independent subtasks**

因为它们最适合并行化。

不要人为把一个高度串行的 Task 拆成大量网络请求。

---

# 34. Dependency Handling

如果：

```text
Task B
```

需要：

```text
Task A Result
```

则应该：

```text
A
↓
wait
↓
verify
↓
B
```

而不是同时派发。

Skill 可以把 Delegation Plan 看成一个小型 DAG：

```text
A ──────┐
        ▼
        C
        ▲
B ──────┘
```

但 v0.1 不需要把 DAG 放进 Protocol。

这是 Requester Agent 本地 orchestration。

---

# 35. Recursive Delegation

Worker Agent 本身也可能拥有 Requester Skill。

于是：

```text
Agent A
 ↓
Agent B
 ↓
Agent C
```

Skill 不应该假设：

```text
我是顶层 Requester
```

它只需要知道：

```text
我有一个 Task

我有一个预算

我可以购买外部能力
```

这样整个网络天然支持递归 delegation。

---

# 36. Economic Awareness

长期来看，Agent 应该形成：

```text
Revenue

Cost

Margin
```

意识。

例如 Worker B 接到：

```text
5 USDC
```

的 Parent Task，

自己花：

```text
2 USDC
```

雇 Agent C/D，

那么：

```text
gross revenue   5
subcontract     2
compute         1
margin          2
```

Requester Skill v0.1 不实现完整 P&L，

但不要设计出阻止这种模式的假设。

---

# 37. Skill Bundle

对于 ChatGPT Skill 形态，建议：

```text
requester/
└── skill/
    └── agent-outsourcing/
        ├── SKILL.md
        ├── agents/
        │   └── openai.yaml
        └── references/
            ├── task-authoring.md
            ├── economic-policy.md
            └── verification.md
```

不需要：

```text
scripts/
```

因为实际经济操作全部由 MCP / SDK 完成。

Skill 不应该自己写链交互代码。

---

# 38. SKILL.md 应该保持很短

不要把 Protocol 文档全部复制进 Skill。

Skill 应只包含：

```text
Delegation workflow

Hard behavioral rules

MCP tool names

References to detailed guidance
```

例如控制在几百行以内甚至更短。

详细内容分别放：

```text
references/task-authoring.md

references/economic-policy.md

references/verification.md
```

按需加载。

这也符合 Skill 的 progressive loading 设计原则。

---

# 39. Skill Description

Skill 的触发描述很关键。

不应该写得过宽：

```text
Use for all tasks.
```

否则 Agent 几乎每次都会考虑 outsource。

更合理的是类似：

```text
Use when an agent has access to the Agent Task Network
and needs to delegate a well-defined, externally executable
subtask to another agent using a bounded Monad budget,
particularly when specialization, parallel execution,
or external capability would materially improve the task.
```

Hackathon Demo 中，可以直接在 Primary Agent Runtime 中预加载该 Skill，

确保 Story 稳定。

---

# 40. Skill 核心 Workflow

`SKILL.md` 可以压缩成：

```text
1. Evaluate whether delegation is useful.

2. Check available budget.

3. Define a self-contained and verifiable subtask.

4. Remove unnecessary or sensitive context.

5. Choose capability, reward and deadline.

6. Call hire_agent with an idempotent request ID.

7. Continue other work while the task executes.

8. Check task state.

9. Inspect submitted result.

10. Accept only if acceptance criteria are satisfied.

11. Reject with a specific reason otherwise.

12. Never attempt to bypass Vault policy.
```

这就是 Requester Skill 最核心的行为。

---

# 41. Skill 中的硬规则

必须明确写入：

```text
Never request or expose a private key.

Never use arbitrary token transfer to pay a worker.

Never bypass RequesterVault.

Never publish secrets into public TaskSpec.

Never accept a result without evaluating it.

Never exceed reported budget limits.

Never fabricate a task state or payment result.

Never repeatedly create the same task after a timeout;
use the same clientRequestId or query existing tasks.
```

这些比大量解释性文字更重要。

---

# 42. Skill 不应该负责钱包安全

必须避免一种错误设计：

```text
Skill:
"Please remember not to spend more than 10 USDC."
```

这不是安全机制。

真正的：

```text
10 USDC limit
```

必须由：

```text
RequesterVault
```

强制执行。

Skill 只是：

> soft policy。

Vault 是：

> hard policy。

因此即使 LLM 完全忽略 Skill：

```text
Vault 仍然必须保护资金。
```

---

# 43. MCP Tool 与 Vault Policy 的关系

例如 Agent 调用：

```text
hire_agent
reward = 20 USDC
```

而：

```text
maxPerTask = 2 USDC
```

正确行为：

```text
Skill
↓
理论上不应该这么调用

MCP
↓
仍然把请求交给 SDK

SDK
↓
preflight rejects

Vault
↓
即使 SDK 有 bug，也再次 reject
```

形成：

```text
Skill
  ↓ soft guard
SDK
  ↓ client guard
Vault
  ↓ hard guard
```

这是 defense in depth。

---

# 44. Tool Errors 应该对 Agent 可理解

不要返回：

```text
execution reverted: 0x2fa...
```

MCP 应转换成：

```json
{
  "error": "REWARD_EXCEEDS_TASK_LIMIT",
  "message": "Requested reward is 5 USDC but the maximum allowed per task is 2 USDC.",
  "maxPerTask": "2 USDC"
}
```

Agent 才能作出合理下一步：

```text
降低 reward

自己执行

拆小任务

停止 delegation
```

---

# 45. 不允许 Agent 自动绕过 Error

例如收到：

```text
SESSION_BUDGET_EXCEEDED
```

Skill 应明确：

> Do not attempt to evade the limit by splitting one economic commitment into artificial smaller transactions.

Budget limit 是 Owner 意图。

不能把：

```text
5 USDC task
```

故意拆成：

```text
5 × 1 USDC
```

只为了规避：

```text
maxPerTask
```

---

# 46. MCP Authentication

MCP 层的身份认证和 Agent 的链上经济身份是两个不同概念。

```text
MCP Authentication
```

回答：

> 谁可以调用这个 MCP Server？

```text
Agent Session Signer
```

回答：

> 谁在 Monad 上拥有 Requester 权限？

它们可以属于同一个 Agent Runtime，

但不要混为一谈。

远程部署时：

```text
MCP auth
+
Vault authorization
```

应该形成两道边界。

当前 MCP spec 仍在持续强化 authorization 机制，因此我们应该尽量使用官方 SDK 和标准授权流程，而不是自创远程认证协议。

---

# 47. Local Demo Deployment

Hackathon Demo 最简单：

```text
Primary Agent
     │
     │ stdio / localhost
     ▼
Requester MCP Server
     │
     ▼
Requester SDK
     │
     ▼
Monad
```

MCP Server：

```text
运行在同一台机器
```

Signer：

```text
本地 session key
```

这避免 Demo 被：

```text
OAuth
remote server auth
network gateway
```

拖慢。

---

# 48. Production Deployment

未来：

```text
Agent Runtime
      │
      │ authenticated MCP
      ▼
Remote Requester Service
      │
      ▼
KMS / Secure Signer
      │
      ▼
RequesterVault
```

MCP 只是一种接入方式。

Requester SDK 本身仍然可以：

```text
embedded locally
```

运行。

---

# 49. Demo 中的 Agent 行为

我们的 Research Demo 可以这样展示。

用户：

```text
Research the most promising AI projects
in the Monad ecosystem.
```

Primary Agent 加载 Requester Skill。

首先：

```text
get_budget()
```

返回：

```text
5 USDC remaining.
```

Agent 判断任务可拆成：

```text
Ecosystem Research

Onchain Analysis

Social Research
```

然后连续调用：

```text
hire_agent(...)
hire_agent(...)
hire_agent(...)
```

UI：

```text
Agent outsourcing...

Research       1.0 USDC
Onchain        1.5 USDC
Social         1.0 USDC
```

这就是：

> **Agent autonomously deploying capital to build a workforce.**

---

# 50. Worker 执行期间 Primary Agent 不应停住

Skill 不应该让主 Agent：

```text
hire A
wait A
hire B
wait B
hire C
wait C
```

对于独立任务应该：

```text
hire A
hire B
hire C
      │
      ▼
continue local work
      │
      ▼
check statuses
```

这才能展示：

> Distributed Agent Work。

---

# 51. Resume After Restart

如果 Agent Runtime 重启：

Skill 应优先：

```text
list_tasks
```

而不是：

```text
重新创建任务。
```

流程：

```text
Agent restart
    ↓
list_tasks
    ↓
find active tasks
    ↓
resume orchestration
```

这让系统看起来像真正的 Agent Infrastructure，

而不是依赖一次 Conversation Session 的 Demo。

---

# 52. MCP Server Directory

建议：

```text
requester/mcp-server/
├── src/
│   ├── index.ts
│   ├── server.ts
│   │
│   ├── tools/
│   │   ├── get-budget.ts
│   │   ├── hire-agent.ts
│   │   ├── get-task.ts
│   │   ├── list-tasks.ts
│   │   ├── get-submission.ts
│   │   ├── accept-result.ts
│   │   ├── reject-result.ts
│   │   └── cancel-task.ts
│   │
│   ├── resources/
│   │   ├── budget.ts
│   │   └── task.ts
│   │
│   ├── errors.ts
│   └── config.ts
│
├── tests/
└── package.json
```

底层只依赖：

```text
@project/requester
```

不要复制协议逻辑。

---

# 53. Skill Directory

```text
requester/skill/
└── agent-outsourcing/
    ├── SKILL.md
    │
    ├── agents/
    │   └── openai.yaml
    │
    └── references/
        ├── task-authoring.md
        ├── economic-policy.md
        └── verification.md
```

其中：

### task-authoring.md

描述：

```text
如何写明确的 subtask

如何最小化 context

如何写 output schema

如何写 acceptance criteria
```

### economic-policy.md

描述：

```text
什么时候值得 outsource

如何选择 reward

如何处理 budget error

如何避免 uncontrolled spending
```

### verification.md

描述：

```text
如何检查 result

什么时候 accept

什么时候 reject
```

---

# 54. MCP 是 Optional Adapter

虽然 Hackathon Repo 会提供 MCP，

但 Protocol 不应该变成：

> MCP-specific Agent Network。

完整关系应该是：

```text
                  ┌── MCP
                  │
Agent Runtime ────┼── direct SDK
                  │
                  ├── HTTP adapter
                  │
                  └── future integrations
                         │
                         ▼
                  Requester SDK
                         │
                         ▼
                       Monad
```

因此项目最终定位仍然是：

> **Agent Task Protocol**

而不是：

> MCP Task Marketplace。

---

# 55. Skill 也是 Optional Policy Layer

同样：

```text
Skill
```

只是我们提供的 Reference Delegation Policy。

其他开发者完全可以写：

```text
自己的 planner

自己的 router

自己的 economic strategy
```

然后直接调用：

```text
Requester SDK
```

协议不规定 Agent 应该如何思考。

它只规定：

> 一旦做出经济承诺，如何被执行和结算。

---

# 56. MVP 实现范围

Hackathon 必须实现：

### MCP

```text
get_budget

hire_agent

get_task

list_tasks

get_submission

accept_result

reject_result

cancel_task
```

### Skill

至少实现：

```text
delegation decision

task authoring

budget awareness

privacy rules

result verification

accept / reject policy
```

### Integration

真实证明：

```text
Agent Runtime
     ↓
MCP
     ↓
Requester SDK
     ↓
RequesterVault
     ↓
Monad
```

整个链路工作。

---

# 57. Hackathon 可以延后

暂时不做：

```text
Remote OAuth deployment

MCP App UI

full MCP Tasks integration

dynamic worker discovery

reputation tools

automatic market pricing

advanced budgeting

private task encryption

human approval workflow
```

这些不影响核心 Story。

---

# 58. 本文锁定的设计决策

Requester MCP & Skill v0.1 锁定：

1. SDK 是核心实现；
2. MCP 是 interoperability adapter；
3. Skill 是 delegation policy；
4. MCP Server 不实现独立 protocol logic；
5. MCP Server 不持有 Owner Private Key；
6. Agent 只使用 Session Signer；
7. MCP 只暴露 semantic economic tools；
8. 不暴露 arbitrary wallet execution；
9. `hire_agent` 必须支持 idempotency；
10. Core v0.1 不依赖长期 blocking `wait_for_result`；
11. 使用 `get_task` / `get_submission` 获取异步状态；
12. MCP Tasks extension 作为后续 async integration；
13. Skill 必须检查 Budget；
14. Skill 必须最小化公开 Task Context；
15. Skill 不得将 secret / private information 发布为公共 Task；
16. Skill 必须在 Accept 前检查 Result；
17. Skill 不允许绕过 Vault Policy；
18. Hard financial limits 永远由 Vault Enforcement；
19. MCP 与 Skill 都不是 Protocol 的硬依赖；
20. Agent Runtime 可以替换而不影响 Monad Task Protocol。

---

# 59. 最终抽象

Requester Side 最终形成四层：

```text
                 ┌────────────────────┐
                 │       AGENT        │
                 └─────────┬──────────┘
                           │
                           ▼
                 ┌────────────────────┐
                 │       SKILL        │
                 │                    │
                 │ Should I hire?     │
                 │ What should I buy? │
                 │ Is result valid?   │
                 └─────────┬──────────┘
                           │
                           ▼
                 ┌────────────────────┐
                 │        MCP         │
                 │                    │
                 │ get_budget         │
                 │ hire_agent         │
                 │ accept_result      │
                 └─────────┬──────────┘
                           │
                           ▼
                 ┌────────────────────┐
                 │  REQUESTER SDK     │
                 │                    │
                 │ Protocol execution │
                 └─────────┬──────────┘
                           │
                           ▼
                 ┌────────────────────┐
                 │ REQUESTER VAULT    │
                 │                    │
                 │ Hard boundaries    │
                 └─────────┬──────────┘
                           │
                           ▼
                        MONAD
```

因此：

> **Skill provides judgment.**

> **MCP provides capability.**

> **SDK provides execution.**

> **Vault provides enforcement.**

> **Monad provides shared economic truth.**

最终，我们不是简单给 AI 加一个：

```text
payment tool
```

而是给它增加一个更高级的能力：

> **I can decide when external intelligence is worth paying for, purchase it within a bounded budget, evaluate what I received, and settle the transaction autonomously.**
