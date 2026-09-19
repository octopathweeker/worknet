# Requester SDK Design

## 1. 文档目的

Requester SDK 是 Agent 与 Agent Task Protocol 之间的主要编程接口。

它的目标不是让 Agent 开发者理解：

* TaskManager ABI；
* RequesterVault ABI；
* TaskSpec hashing；
* event polling；
* offchain storage；
* USDC decimals；
* transaction lifecycle。

而是让开发者可以用一个非常简单的 primitive：

```ts
const task = await requester.hire({
  capability: "research.web",
  instructions: "Research Monad AI projects",
  reward: "1.0",
  deadline: "5m",
});

const result = await task.wait();
```

从 Agent 的视角：

> **hire() 就像 callTool()，只是背后调用的不是预先集成的工具，而是开放网络中的另一个 Agent。**

---

# 2. SDK 在系统中的位置

整体关系：

```text
Agent Runtime
     │
     │ hire(...)
     ▼
Requester SDK
     │
     ├── Budget
     ├── TaskSpec
     ├── Storage
     ├── Signing
     ├── Contract Calls
     ├── Events
     └── Result Fetching
             │
             ▼
     RequesterVault
             │
             ▼
        TaskManager
             │
             ▼
           Monad
```

Requester SDK 是：

> **Agent-facing protocol client**

而不是：

> wallet library

也不是：

> smart-contract wrapper

---

# 3. 设计原则

## 3.1 一个主要入口

SDK 的主要对象：

```ts
Requester
```

核心操作：

```ts
requester.hire()
```

不应该要求普通开发者分别实例化：

```text
VaultClient

TaskManagerClient

StorageClient

EventClient
```

这些应该隐藏在内部。

---

## 3.2 High-level First

SDK 同时可以提供：

```text
High-level API
```

和：

```text
Low-level protocol API
```

但默认文档和 Demo 应该全部使用 High-level API。

例如：

```ts
requester.hire()
```

而不是：

```ts
uploadTaskSpec()
hashTaskSpec()
approveToken()
callVault()
parseTaskCreated()
watchResultSubmitted()
downloadManifest()
```

---

## 3.3 Framework Neutral

SDK 不应该依赖：

```text
OpenAI Agents SDK

Claude

LangChain

CrewAI

AutoGen
```

它只是一个普通 TypeScript library。

任何 Runtime 都能调用。

---

# 4. Package

建议：

```text
@project/requester
```

或者未来确定项目品牌之后：

```text
@project-name/requester
```

安装：

```bash
npm install @project/requester
```

底层链交互建议建立在：

```text
viem
```

或其他轻量 EVM client 之上。

MVP 不需要自己重新实现 wallet / RPC stack。

---

# 5. 最基本使用体验

初始化：

```ts
import { createRequester } from "@project/requester";

const requester = createRequester({
  chain: monadTestnet,
  rpcUrl: process.env.MONAD_RPC_URL,

  account: agentSigner,

  vault: process.env.REQUESTER_VAULT,

  storage: storageAdapter,
});
```

然后：

```ts
const task = await requester.hire({
  capability: "research.web",

  instructions: `
    Research notable AI projects
    in the Monad ecosystem.
  `,

  output: {
    type: "object",
    required: [
      "projects",
      "summary"
    ]
  },

  reward: "1.0 USDC",

  deadline: "5m",
});
```

返回：

```ts
TaskHandle
```

---

# 6. TaskHandle

`hire()` 不应该直接等待 Worker 完成。

创建任务成功以后立即返回：

```ts
interface TaskHandle {
  id: bigint;

  status(): Promise<TaskStatus>;

  wait(): Promise<TaskResult>;

  getSubmission(): Promise<Submission | null>;

  accept(): Promise<TransactionReceipt>;

  reject(
    reason?: string
  ): Promise<TransactionReceipt>;

  cancel(): Promise<TransactionReceipt>;
}
```

使用：

```ts
const task = await requester.hire(...);

console.log(task.id);

const result = await task.wait();
```

---

# 7. hire() 的真实含义

从调用者看来：

```text
hire()
```

只有一个函数。

但内部实际上完成：

```text
Input
 ↓
Validate
 ↓
Build TaskSpec
 ↓
Canonicalize
 ↓
Hash
 ↓
Upload TaskSpec
 ↓
Check Agent Authorization
 ↓
Check Budget
 ↓
Submit Vault Transaction
 ↓
Wait for confirmation
 ↓
Parse TaskCreated
 ↓
Return TaskHandle
```

这些都应该由 SDK 处理。

---

# 8. HireParams

建议概念模型：

```ts
interface HireParams {
  capability: string;

  title?: string;

  instructions: string;

  input?: unknown;

  output?: OutputSchema;

  verification?: VerificationPolicy;

  reward: MoneyInput;

  deadline: DurationInput;

  claimLease?: DurationInput;

  reviewWindow?: DurationInput;

  metadata?: Record<string, unknown>;
}
```

MVP 中真正必填：

```text
capability

instructions

reward

deadline
```

其他字段都应该有合理默认值。

---

# 9. 示例

最简单：

```ts
const task = await requester.hire({
  capability: "research.web",
  instructions: "Find 5 Monad AI projects.",
  reward: "1 USDC",
  deadline: "5m",
});
```

复杂一点：

```ts
const task = await requester.hire({
  capability: "analysis.onchain",

  title: "Analyze contract activity",

  instructions:
    "Analyze the last 24h activity of the given contracts.",

  input: {
    contracts: [
      "0x...",
      "0x..."
    ]
  },

  output: {
    type: "object",
    required: [
      "transactions",
      "summary"
    ]
  },

  reward: "1.5 USDC",

  deadline: "10m",

  claimLease: "3m",

  reviewWindow: "2m",
});
```

---

# 10. Money Input

开发者不应该自己处理：

```text
USDC 6 decimals
```

SDK 接受：

```ts
reward: "1.5 USDC"
```

也可以接受：

```ts
reward: {
  amount: "1.5",
  token: "USDC"
}
```

MVP 默认 settlement token 已经由 Vault 固定。

因此最简单还可以：

```ts
reward: "1.5"
```

代表：

```text
1.5 USDC
```

但正式 API 最好避免隐式 token 含义。

推荐：

```ts
reward: usdc("1.5")
```

例如：

```ts
await requester.hire({
  ...
  reward: usdc("1.5")
});
```

---

# 11. Deadline API

Agent 不应该手动计算 Unix timestamp。

支持：

```ts
deadline: "5m"
```

```ts
deadline: "1h"
```

或者：

```ts
deadline: new Date(...)
```

内部转换：

```text
now + duration
↓
uint64 timestamp
```

SDK 同时检查：

```text
deadline
+
reviewWindow
<
authorization expiry
```

避免创建一个 Agent 已经没有权限完成的任务。

---

# 12. Budget API

Requester 必须能够查询自己的经济状态。

```ts
const budget =
  await requester.getBudget();
```

返回：

```ts
interface RequesterBudget {
  vaultBalance: bigint;

  maxPerTask: bigint;

  totalLimit: bigint;

  committed: bigint;

  remainingCommitment: bigint;

  authorizationValidUntil: number;

  active: boolean;
}
```

高层展示：

```text
Vault Balance       42.50 USDC

Session Limit       10.00 USDC

Committed            3.50 USDC

Remaining            6.50 USDC

Max Per Task         2.00 USDC

Expires In           5h 42m
```

---

# 13. SDK 必须做 Preflight

Agent 调用：

```ts
requester.hire(...)
```

时，不应该先直接发交易再等待 revert。

SDK 应先检查：

```text
authorization active?

reward <= maxPerTask?

reward <= remaining commitment?

vault balance sufficient?

deadline valid?

authorization valid long enough?
```

例如：

```ts
await requester.hire({
  reward: usdc("5")
});
```

而：

```text
maxPerTask = 2 USDC
```

SDK 应立即抛出：

```text
RewardExceedsTaskLimit
```

而不是浪费 gas。

---

# 14. Error Model

SDK 应定义结构化 Error。

例如：

```ts
class InsufficientVaultBalanceError {}

class RewardExceedsTaskLimitError {}

class SessionBudgetExceededError {}

class AuthorizationExpiredError {}

class InvalidTaskDeadlineError {}

class TaskAlreadyClaimedError {}

class TaskNotFoundError {}

class InvalidSubmissionError {}

class StorageUploadError {}

class TransactionRevertedError {}
```

Agent 可以基于 Error 做决策。

例如：

```ts
try {
  await requester.hire(...);
} catch (err) {
  if (err instanceof SessionBudgetExceededError) {
    // do task locally instead
  }
}
```

这非常重要。

Agent 不应该只能看到：

```text
transaction reverted
```

---

# 15. TaskSpec Builder

SDK 内部负责把：

```ts
HireParams
```

转换成标准协议：

```json
{
  "protocol": "agent-task/0.1",
  "capability": "research.web",
  "title": "...",
  "instructions": "...",
  "input": {},
  "output": {},
  "verification": {},
  "execution": {}
}
```

开发者可以高级使用：

```ts
requester.buildTaskSpec()
```

但普通使用无需手动操作。

---

# 16. Canonicalization

因为：

```text
specHash
```

会记录在 Monad 上，

所以必须定义稳定的 JSON canonicalization。

否则：

```json
{
  "a": 1,
  "b": 2
}
```

和：

```json
{
  "b": 2,
  "a": 1
}
```

语义一样，

但普通 JSON stringify 可能产生不同 hash。

因此 SDK 必须使用明确的：

> deterministic JSON serialization

规则。

例如采用标准化 JSON canonicalization 方案。

整个：

```text
requester-sdk

worker-sdk
```

必须复用同一个：

```text
protocol canonicalizer
```

package。

---

# 17. Protocol Package

因此 repo 中需要：

```text
packages/protocol/
```

Requester SDK 不应该自己实现一套 TaskSpec。

建议：

```text
packages/protocol/
├── schemas/
├── canonicalize/
├── hash/
├── types/
└── validation/
```

然后：

```text
requester-sdk
worker-sdk
indexer
app
```

全部复用。

---

# 18. Storage Adapter

SDK 不应该锁死 TaskSpec 存储位置。

定义：

```ts
interface StorageAdapter {
  put(
    data: Uint8Array,
    options?: StorageOptions
  ): Promise<StoredObject>;

  get(
    uri: string
  ): Promise<Uint8Array>;
}
```

返回：

```ts
interface StoredObject {
  uri: string;
  hash?: string;
}
```

---

# 19. MVP Storage

Hackathon 第一版建议最简单：

```text
HTTP / object storage
```

或者：

```text
IPFS-compatible storage
```

如果使用中心化 storage：

协议仍然安全地保证：

```text
内容不能被偷偷修改
```

因为：

```text
specHash
```

在链上。

但不能保证：

```text
内容永远可用
```

这是 Availability 问题。

Hackathon 可以接受。

---

# 20. Inline Storage

为了开发和测试，可以提供：

```ts
MemoryStorageAdapter
```

或者：

```ts
LocalFileStorageAdapter
```

例如 integration test：

```text
Requester
↓
local storage
↓
Worker
```

无需依赖外部 IPFS 服务。

---

# 21. Task Discovery 不属于 Requester SDK

Requester SDK 不需要：

```text
search workers
```

因为 Protocol v0.1 使用：

```text
public Task
+
first valid claim
```

Requester 创建 Task 后：

```text
Worker Network
```

负责发现。

Requester 只等待：

```text
TaskClaimed
ResultSubmitted
```

事件。

未来如果加入：

```text
worker routing
reputation
bidding
```

可以增加 Discovery Service。

但不能污染 v0.1 核心 API。

---

# 22. wait() 的语义

最自然的 API：

```ts
const result = await task.wait();
```

但这里必须定义清楚。

`wait()` 不是：

> wait until settled

而更合理的是：

> wait until a Worker submits a result。

即：

```text
OPEN
 ↓
CLAIMED
 ↓
SUBMITTED
      ↑
   wait() resolve
```

因为之后 Requester Agent 需要：

```text
verify
```

然后决定：

```text
accept / reject
```

---

# 23. Recommended High-level Flow

完整使用：

```ts
const task = await requester.hire({...});

const submission = await task.wait();

const verdict =
  await myVerifier.verify(submission.result);

if (verdict.accept) {
  await task.accept();
} else {
  await task.reject(verdict.reason);
}
```

这非常符合 Protocol。

---

# 24. 更高层 convenience API

同时可以提供：

```ts
requester.hireAndVerify()
```

例如：

```ts
const result =
  await requester.hireAndVerify({
    task: {
      capability: "research.web",
      instructions: "...",
      reward: usdc("1"),
      deadline: "5m"
    },

    verify: async result => {
      return result.projects.length >= 5;
    }
  });
```

内部：

```text
hire
 ↓
wait
 ↓
verify
 ↓
accept / reject
```

但 MVP 文档最好还是先展示显式生命周期，

因为这是 Hackathon 项目的核心价值。

---

# 25. Submission

`task.wait()` 返回：

```ts
interface Submission<T = unknown> {
  taskId: bigint;

  worker: Address;

  result: T;

  resultHash: Hex;

  resultURI: string;

  submittedAt: number;

  reviewDeadline: number;

  metadata?: Record<string, unknown>;
}
```

SDK 内部已经完成：

```text
fetch resultURI
↓
canonicalize
↓
hash
↓
compare onchain resultHash
```

如果不一致：

```text
InvalidSubmissionError
```

Requester Agent 不应该自己处理这个细节。

---

# 26. Typed Result

如果调用方提供：

```text
output schema
```

SDK 可以允许泛型：

```ts
interface ResearchResult {
  projects: Project[];
  summary: string;
}

const task =
  await requester.hire<ResearchResult>({
    ...
  });

const submission =
  await task.wait();

submission.result.projects;
```

Runtime 层仍然应该做 schema validation。

TypeScript 泛型只提供开发体验，

不能替代运行时验证。

---

# 27. Runtime Schema Validation

如果：

```text
output
```

是 JSON Schema，

Requester SDK 在返回 Result 前可以先执行：

```text
schema validation
```

例如：

```text
required property missing
```

则 Submission 标记：

```text
schemaValid = false
```

或直接抛：

```text
ResultSchemaValidationError
```

我的建议：

不要自动 Reject。

应该返回给 Requester Agent：

```ts
{
  result,
  validation: {
    schemaValid: false,
    errors: [...]
  }
}
```

让 Agent 决定。

---

# 28. watchTask()

Requester 可以监听生命周期：

```ts
for await (
  const event of requester.watchTask(task.id)
) {
  console.log(event);
}
```

可能输出：

```text
TaskCreated

TaskClaimed

ResultSubmitted

ResultRejected

TaskReopened

TaskSettled
```

这对：

```text
CLI
Demo UI
MCP
Explorer
```

都很有价值。

---

# 29. Wait Strategy

`wait()` 内部应该支持两种模式：

```text
Event subscription
```

优先；

```text
RPC polling
```

fallback。

架构：

```text
Monad RPC / WS
     │
     ▼
EventWatcher
     │
     ├── WebSocket
     └── Polling fallback
```

不要让 Worker / Requester 强依赖中央后端才能工作。

---

# 30. Reorg / Confirmation

虽然 Monad finality 快，

SDK 仍然应该明确：

```text
transaction submitted
```

和：

```text
transaction confirmed
```

是不同状态。

`hire()` 应该在：

```text
TaskCreated
```

得到确认之后再返回 TaskHandle。

Hackathon 不需要构建复杂 reorg manager，

但 SDK 应该使用链 client 的标准 receipt / confirmation 机制。

---

# 31. Transaction Abstraction

Agent API 不应该看到：

```ts
walletClient.writeContract(...)
```

而应该看到：

```ts
task = requester.hire(...)
```

但 SDK 可以提供：

```ts
task.transactionHash
```

供：

```text
Explorer
Debug
Demo
```

使用。

---

# 32. Requester Account Adapter

从上一份 Wallet Design 延续：

```ts
interface RequesterAccount {
  getBudget(): Promise<RequesterBudget>;

  createTask(
    task: PreparedTask
  ): Promise<CreateTaskResult>;

  acceptResult(
    taskId: bigint
  ): Promise<TxResult>;

  rejectResult(
    taskId: bigint,
    reasonHash: Hex
  ): Promise<TxResult>;

  cancelTask(
    taskId: bigint
  ): Promise<TxResult>;
}
```

MVP：

```text
VaultRequesterAccount
```

未来：

```text
EIP7702RequesterAccount
```

Requester SDK 不应该关心二者差异。

---

# 33. Signer Adapter

Agent private key 的来源也应该抽象。

```ts
interface AgentSigner {
  address: Address;

  signTransaction(...): Promise<Hex>;
}
```

可以实现：

```text
PrivateKeySigner

LocalKeySigner

KmsSigner

RemoteSigner

HardwareSigner
```

Requester SDK 永远不要要求：

```ts
privateKey: "0x..."
```

作为唯一初始化方式。

---

# 34. Agent Runtime Integration

Requester SDK 应该很容易包装成：

```text
Tool

MCP

Skill

Function Call
```

例如 OpenAI / Claude 风格工具：

```ts
async function hireAgent(args) {
  return requester.hire(args);
}
```

因此核心 SDK 不需要知道 LLM。

---

# 35. Agent-facing Tool Surface

给 Agent 暴露的工具不应该等于 SDK 全部 API。

建议只有：

```text
get_budget

hire_agent

get_task

wait_for_result

accept_result

reject_result

cancel_task
```

这是下一篇 MCP / Skill Design 的基础。

---

# 36. Delegation Context

Requester Agent 在 outsource 一个复杂 Parent Task 时，

最好能够给子任务增加：

```text
parentTaskId
```

或者：

```text
delegation metadata
```

例如：

```json
{
  "metadata": {
    "parent": "local:research-42"
  }
}
```

但 MVP 不需要把递归任务关系写到链上。

它可以作为 TaskSpec metadata。

---

# 37. Recursive Delegation

Requester SDK 本质上应该允许：

> Worker 同时也是 Requester。

例如：

```text
Agent A
 ↓ hire
Agent B
 ↓ hire
Agent C
```

Agent B 可以同时运行：

```text
worker-sdk
+
requester-sdk
```

这是非常重要的。

协议层不应该限制：

```text
workerAddress
```

不能成为：

```text
requester operator
```

否则无法形成递归 Agent Economy。

---

# 38. Parent Budget 与 Subcontracting

MVP 不强制：

```text
subtask cost <= parent reward
```

因为 Parent Task 与 Subtask 可能由不同经济账户支持。

但 Skill 层应该建议：

```text
Agent 不应该无意义地花超过任务经济价值的预算。
```

未来可以引入：

```text
P&L aware worker
```

例如：

```text
Parent reward        5 USDC

Subtasks             2 USDC

Compute cost         1 USDC

Agent margin         2 USDC
```

Requester SDK 不负责这个经济策略。

---

# 39. Idempotency

Agent Runtime 可能因为：

```text
retry

network timeout

process restart
```

重复调用：

```text
hire()
```

如果每次都创建新 Task，会发生重复花钱。

因此 SDK 应支持：

```ts
idempotencyKey
```

例如：

```ts
await requester.hire({
  ...,
  idempotencyKey:
    "parent-42/research"
});
```

SDK 可以在本地状态或上层 service 中避免重复创建。

---

# 40. Protocol-level Idempotency

更完整方案可以把：

```text
clientRequestId
```

编码进：

```text
TaskSpec
```

甚至链上：

```text
requester + requestId
```

唯一。

但这会增加合约复杂度。

Hackathon MVP：

> SDK-level idempotency 即可。

---

# 41. Process Restart Recovery

Requester Agent 重启以后，

不应该丢失已经创建的 Task。

SDK 可以：

```ts
const task =
  requester.task(taskId);
```

然后：

```ts
await task.status();
await task.wait();
```

因此 `TaskHandle` 不应该依赖内存中的 hidden state。

它应该主要由：

```text
taskId
+
chain state
```

重建。

---

# 42. listTasks()

方便 Agent 恢复状态：

```ts
await requester.listTasks({
  status: [
    "OPEN",
    "CLAIMED",
    "SUBMITTED"
  ]
});
```

MVP 可以通过：

```text
event scan
```

实现。

更高性能版本可以使用 Indexer。

这不是合约必须支持的 view。

---

# 43. Local Persistence

SDK 可以维护轻量数据库：

```text
.requester/
└── state.json
```

或：

```text
SQLite
```

保存：

```text
idempotency keys

local metadata

known tasks

storage mappings
```

但：

> 链上状态仍然是经济状态的 source of truth。

Local DB 不能决定 Task 是否 SETTLED。

---

# 44. Logging

Agent 相关系统特别需要结构化日志。

例如：

```text
[requester]
task.build

[requester]
task.upload

[requester]
budget.preflight

[requester]
tx.submit

[requester]
task.created
```

日志不要包含：

```text
private key

secret token

sensitive prompt data
```

尤其 TaskSpec 可能包含用户数据。

---

# 45. Observability Hooks

SDK 可以提供：

```ts
createRequester({
  onEvent(event) {
    ...
  }
});
```

事件例如：

```text
task:preparing

task:uploaded

transaction:submitted

task:created

task:claimed

result:submitted

result:accepted

task:settled
```

Demo UI 可以直接利用这些事件，

而无需把 UI 逻辑写进 SDK。

---

# 46. Explorer Integration

TaskHandle 可以提供：

```ts
task.explorerUrl
```

或者：

```ts
requester.getExplorerUrl(task.id)
```

让 Demo 可以直接：

```text
View on Monad
```

但 Explorer URL 属于 chain config，

不应该 hardcode 到协议包。

---

# 47. Testing Strategy

Requester SDK 至少需要三层测试。

## Unit

测试：

```text
TaskSpec building

canonicalization

hashing

money parsing

deadline parsing

preflight policy
```

---

## Contract Integration

使用：

```text
local EVM / Monad-compatible test environment
```

真实调用：

```text
RequesterVault

TaskManager
```

验证：

```text
hire → TaskCreated
```

---

## End-to-End

启动：

```text
Requester process

Worker process
```

完成：

```text
hire
claim
submit
accept
settle
```

这也是 Hackathon Repo 最重要的测试。

---

# 48. CLI

虽然 SDK 是核心，

我建议同时提供非常薄的一层：

```text
requester-cli
```

例如：

```bash
agent-requester budget
```

输出：

```text
Vault Balance: 10 USDC
Remaining Budget: 5 USDC
```

发布：

```bash
agent-requester hire \
  --capability research.web \
  --reward 1 \
  --deadline 5m \
  --instructions "Research Monad AI projects"
```

这对调试和 Demo 非常有帮助。

但 CLI 只是 SDK 的 adapter。

---

# 49. SDK Directory

建议：

```text
packages/requester-sdk/
├── src/
│   ├── requester.ts
│   ├── task-handle.ts
│   │
│   ├── account/
│   │   ├── types.ts
│   │   └── vault-account.ts
│   │
│   ├── signer/
│   │   ├── types.ts
│   │   └── private-key.ts
│   │
│   ├── storage/
│   │   ├── types.ts
│   │   ├── http.ts
│   │   └── memory.ts
│   │
│   ├── watchers/
│   │   └── task-watcher.ts
│   │
│   ├── budget/
│   │   └── preflight.ts
│   │
│   └── errors.ts
│
├── tests/
└── package.json
```

协议公共部分：

```text
packages/protocol/
```

不要复制到 requester-sdk。

---

# 50. Public API

MVP Public API 尽量控制在：

```ts
createRequester()

requester.getBudget()

requester.hire()

requester.task()

requester.listTasks()
```

以及：

```ts
task.status()

task.wait()

task.accept()

task.reject()

task.cancel()
```

其余尽量保持 internal。

---

# 51. Demo API

Hackathon Demo 的完整 Requester 代码应该尽可能短。

理想状态：

```ts
const requester =
  createRequester(config);

console.log(
  await requester.getBudget()
);

const task =
  await requester.hire({
    capability: "research.web",

    instructions:
      "Research 5 Monad AI projects.",

    reward: usdc("1"),

    deadline: "5m",
  });

console.log(
  `Task #${task.id} created`
);

const submission =
  await task.wait();

const ok =
  verifyResearch(
    submission.result
  );

if (ok) {
  await task.accept();
}
```

如果核心 Demo 需要写 200 行 Requester orchestration，

说明 SDK 设计还不够好。

---

# 52. Developer Story

README 对 Requester 开发者应该只讲三个步骤：

```text
1. Create or connect a RequesterVault

2. Give your Agent limited authority

3. Call requester.hire()
```

核心示例：

```ts
const task = await requester.hire({
  capability: "research.web",
  instructions: "Research this topic.",
  reward: usdc("1"),
  deadline: "5m",
});

const submission = await task.wait();

await task.accept();
```

这就是整个 Requester Developer Experience。

---

# 53. SDK 不负责什么

Requester SDK 明确不负责：

```text
LLM reasoning

whether task should be outsourced

reward pricing strategy

worker reputation

worker selection

result semantic correctness

human approval logic

advanced dispute resolution
```

这些分别属于：

```text
Skill

Routing

Verification

Policy
```

---

# 54. 本文锁定的设计决策

Requester SDK v0.1 暂时锁定：

1. TypeScript 作为第一 SDK；
2. `Requester` 是主要入口；
3. `hire()` 是核心 primitive；
4. `hire()` 返回 `TaskHandle`；
5. `wait()` 默认等待 Result Submission；
6. Accept / Reject 显式进行；
7. SDK 自动构建 TaskSpec；
8. SDK 自动 canonicalize + hash；
9. Storage 采用 Adapter；
10. Account 采用 Adapter；
11. Signer 采用 Adapter；
12. 默认使用 VaultRequesterAccount；
13. SDK 在发交易前执行 Budget Preflight；
14. Result 自动验证 resultHash；
15. TaskHandle 可以通过 taskId 恢复；
16. Event subscription + RPC polling fallback；
17. SDK 不绑定任何 Agent Framework；
18. Worker 可以同时实例化 Requester SDK，实现递归 delegation。

---

# 55. 最终抽象

对于协议开发者：

```text
Requester SDK
=
Protocol Client
+
Wallet Policy Client
+
Task Storage Client
+
Event Client
```

但对于 Agent：

它应该只有一个新的能力：

```text
hire(
  capability,
  task,
  budget
)
```

过去 Agent 的能力边界是：

```text
Model
+
Tools
```

现在变成：

```text
Model
+
Tools
+
Budget
+
External Agents
```

这就是 Requester SDK 真正提供的 primitive：

> **Turn money into external capability.**

或者从 Agent 的视角：

> **When I cannot or should not do something myself, I can hire another agent to do it.**
