# Smart Contract Architecture Design

## 1. 文档目的

本文定义 Agent Task Network 在 Monad 上的 Smart Contract Architecture。

前面的文档已经确定：

```text
Owner
  ↓
RequesterVault
  ↓
Requester Agent

Requester Agent
  ↓
Task

Worker
  ↓
Result

Verifier
  ↓
Settlement
```

本文进一步回答：

1. 哪些状态应该存在链上；
2. `RequesterVault` 和 `TaskManager` 如何分工；
3. Reward 应该锁在哪里；
4. 哪些角色可以触发哪些状态变化；
5. 如何保证资金与 Task 状态始终一致；
6. Hackathon MVP 应该实现到什么程度。

---

# 2. Smart Contract 的核心职责

链上系统只负责：

> **Economic commitments and shared coordination state.**

它不负责：

```text
LLM execution

Agent reasoning

Task decomposition

Worker computation

TaskSpec storage

Result storage

semantic verification
```

它负责：

```text
Who funded the task?

Who can spend the budget?

Who claimed the task?

Who submitted the result?

Has the task been accepted?

Who should receive the money?

Can the money be refunded?
```

---

# 3. v0.1 合约架构

建议 Hackathon 第一版保持两份核心合约：

```text
┌─────────────────────┐
│  RequesterVault     │
│                     │
│ budget              │
│ agent authorization │
│ owner control       │
└──────────┬──────────┘
           │
           │ funded task
           ▼
┌─────────────────────┐
│    TaskManager      │
│                     │
│ lifecycle           │
│ escrow              │
│ worker              │
│ result              │
│ settlement          │
└─────────────────────┘
```

也就是说：

```text
RequesterVault
+
TaskManager
```

暂时**不单独部署 `Settlement.sol`**。

---

# 4. 为什么 Settlement 暂时并入 TaskManager

之前架构里有：

```text
RequesterVault
TaskManager
Settlement
```

但对于 v0.1：

```text
Settlement
```

实际上只有两个核心行为：

```text
pay worker
refund requester
```

如果拆成第三份合约，会增加：

```text
cross-contract calls

approval management

state synchronization

deployment complexity

test complexity

attack surface
```

而没有明显收益。

因此 Hackathon v0.1：

> **Escrow + Settlement directly live inside TaskManager.**

未来如果支持：

```text
milestones

split payment

streaming

protocol fee

multiple verifiers

worker bond

revenue sharing
```

再独立 Settlement Module。

---

# 5. 合约关系

完整资金与权限路径：

```text
                   OWNER
                     │
             deposit / withdraw
                     │
                     ▼
             RequesterVault
                     │
              authorize Agent
                     │
                     ▼
              Agent Operator
                     │
                 createTask
                     │
                     ▼
             RequesterVault
                     │
             transfer reward
                     │
                     ▼
               TaskManager
                     │
                   escrow
                     │
        ┌────────────┴────────────┐
        │                         │
     success                    refund
        │                         │
        ▼                         ▼
     Worker                RequesterVault
```

---

# 6. Source of Truth

两个合约分别是不同信息的 Source of Truth。

## RequesterVault

负责：

```text
Who owns this budget?

Which Agent is authorized?

How much can that Agent commit?

Is the authorization still active?
```

---

## TaskManager

负责：

```text
Does Task #1024 exist?

What state is it in?

Who claimed it?

What reward is locked?

What result was submitted?

Has it been settled?
```

两者职责不要交叉。

---

# 7. RequesterVault 状态

概念结构：

```solidity
contract RequesterVault {
    address public owner;

    IERC20 public immutable settlementToken;

    ITaskManager public immutable taskManager;

    bool public paused;

    mapping(address => AgentAuthorization)
        public authorizations;

    mapping(uint256 => address)
        public taskOperators;
}
```

Authorization：

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

---

# 8. 为什么 Vault 固定 Token

v0.1 一个 Vault 只使用：

```text
一个 settlement token
```

例如 USDC。

因此：

```solidity
IERC20 public immutable settlementToken;
```

好处：

```text
预算单位统一

Authorization 简单

没有 malicious token switching

没有 Agent-selected ERC20

没有价格转换问题
```

---

# 9. 为什么 Vault 固定 TaskManager

同理：

```solidity
ITaskManager public immutable taskManager;
```

Agent 不允许：

```text
createTask(
  arbitraryTaskManager
)
```

否则它可以：

```text
创建恶意合约
↓
让 Vault transfer USDC
↓
绕过全部协议
```

所以：

> **TaskManager is part of Vault's trust boundary.**

---

# 10. Vault Ownership

MVP 可以采用非常简单的：

```text
single owner
```

模型。

Owner 可以：

```text
deposit

withdraw

authorizeAgent

revokeAgent

pause

unpause

take over task operations
```

Hackathon 不需要：

```text
multisig

DAO

role hierarchy

governance
```

未来可以把 Owner 替换成：

```text
Safe

Smart Account

DAO Treasury
```

但合约接口不需要为此重新设计。

---

# 11. Deposit

Owner 调用：

```solidity
function deposit(
    uint256 amount
) external onlyOwner;
```

内部：

```text
settlementToken.transferFrom(
  owner,
  vault,
  amount
)
```

事件：

```solidity
event Deposited(
    address indexed owner,
    uint256 amount
);
```

---

# 12. Withdrawal

Owner：

```solidity
function withdraw(
    uint256 amount
) external onlyOwner;
```

只能提取：

```text
Vault 实际余额
```

因为已经进入 TaskManager Escrow 的资金：

```text
已经不属于 Vault balance。
```

这是一个很清晰的设计。

---

# 13. Authorize Agent

Owner 调用：

```solidity
function authorizeAgent(
    address agent,
    AgentAuthorization calldata auth
) external onlyOwner;
```

必须验证：

```text
agent != address(0)

validUntil > validAfter

validUntil > block.timestamp

maxPerTask > 0

maxTotalCommitment >= maxPerTask
```

同时：

```text
committed = 0
```

---

# 14. Reauthorization

这里需要明确一个行为。

不建议：

```text
authorizeAgent(existingAgent)
```

直接覆盖一个仍活跃 Authorization。

否则 `committed` accounting 可能失真。

推荐：

```text
revoke old session
↓
create new authorization
```

或者允许：

```text
renewAuthorization()
```

但只能在旧 Session 已结束后。

MVP 最简单：

> 一个 Agent Address 同一时间只能有一份 Authorization。

---

# 15. Revoke

Owner：

```solidity
function revokeAgent(
    address agent
) external onlyOwner;
```

结果：

```text
auth.active = false
```

立即禁止：

```text
create new task

accept result

reject result

cancel task
```

但不会：

```text
自动取消现有 Task

自动退回 Escrow
```

现有 Task 仍按照协议生命周期运行。

---

# 16. Agent Validation Modifier

概念上：

```solidity
modifier onlyAuthorizedAgent() {
    AgentAuthorization storage auth =
        authorizations[msg.sender];

    require(auth.active);
    require(block.timestamp >= auth.validAfter);
    require(block.timestamp < auth.validUntil);

    _;
}
```

但：

```text
createTask
```

还需要额外检查 Budget。

---

# 17. createTask() 的调用入口

Requester Agent **不直接调用 TaskManager**。

正确调用：

```text
Agent
  ↓
RequesterVault.createTask()
  ↓
TaskManager.createTask()
```

这样：

```text
Agent authority
```

永远先经过 Vault Policy。

---

# 18. Vault TaskParams

概念：

```solidity
struct CreateTaskParams {
    bytes32 capabilityId;

    bytes32 specHash;

    string specURI;

    uint128 rewardAmount;

    uint64 taskDeadline;

    uint64 claimLeaseSeconds;

    uint64 reviewWindowSeconds;
}
```

Settlement Token 不需要传。

因为 Vault 已固定。

---

# 19. createTask() Policy Check

Vault：

```solidity
function createTask(
    CreateTaskParams calldata params
)
    external
    onlyAuthorizedAgent
    returns (uint256 taskId);
```

检查：

```text
reward > 0

reward <= maxPerTask

committed + reward
<= maxTotalCommitment

vault balance >= reward

taskDeadline > now

taskDeadline + reviewWindow
<= authorization.validUntil
```

然后：

```text
auth.committed += reward
```

---

# 20. createTask() 资金移动

推荐流程：

```text
RequesterVault
     │
     │ safeTransfer TaskManager
     ▼
TaskManager
     │
     │ create Task record
     ▼
OPEN
```

但这里必须保证：

> Transfer 与 Task Creation 是原子的。

因此更合理的实现是：

```text
Vault approve TaskManager once
```

然后：

```solidity
taskManager.createTask(
    requesterVault,
    operator,
    params
);
```

由 TaskManager：

```text
transferFrom(
  requesterVault,
  TaskManager,
  reward
)
```

并在同一交易创建 Task。

---

# 21. 为什么由 TaskManager pull Funds

如果 Vault 先：

```text
transfer()
```

再调用：

```text
createTask()
```

虽然同一个 transaction revert 会整体回滚，

但接口语义较散。

更清晰：

```text
TaskManager.createTask()
```

直接完成：

```text
validate caller Vault
+
pull reward
+
create state
```

形成一个原子 operation。

---

# 22. Vault Approval

Deployment / initialization 时：

```text
Vault
↓
approve TaskManager
```

可以选择：

```text
unlimited approval
```

或：

```text
exact allowance management
```

Hackathon 为简化可以使用：

```text
unlimited approval to immutable trusted TaskManager
```

因为 Agent 无法修改 TaskManager 地址。

生产环境可以进一步缩小 allowance 风险。

---

# 23. TaskManager State

概念：

```solidity
contract TaskManager {

    IERC20 public immutable settlementToken;

    uint256 public nextTaskId;

    mapping(uint256 => Task)
        public tasks;
}
```

Task：

```solidity
struct Task {
    address requester;
    address operator;

    address worker;

    bytes32 capabilityId;

    bytes32 specHash;

    bytes32 resultHash;

    uint128 rewardAmount;

    uint64 createdAt;
    uint64 taskDeadline;

    uint64 claimLeaseSeconds;
    uint64 claimLeaseExpiresAt;

    uint64 reviewWindowSeconds;
    uint64 submittedAt;

    TaskStatus status;
}
```

---

# 24. specURI / resultURI 是否存储在 Struct

这里建议做一个取舍。

完整：

```text
specURI
resultURI
```

如果作为 Solidity dynamic string 保存在 storage，

gas 成本更高。

MVP 可以采用：

```text
Hash → storage

URI → event
```

即：

```text
Task struct
保存 specHash
```

事件：

```text
TaskCreated(..., specURI)
```

Indexer / Worker 从 Event 获取 URI。

同样：

```text
resultHash → storage
resultURI → ResultSubmitted event
```

---

# 25. 为什么 URI 可以只存在 Event

URI 不影响核心经济状态。

真正需要长期验证的是：

```text
specHash
resultHash
```

Event 已经：

```text
不可变

可索引

可通过日志恢复
```

因此没必要为 URI 支付永久 Contract Storage 成本。

---

# 26. 但 Hackathon 可以先存 URI

如果为了开发速度，

v0.1 也完全可以直接：

```solidity
string specURI;
string resultURI;
```

这样：

```text
getTask()
```

更简单。

Hackathon 的 Task 数量很少，

gas 成本不是主要问题。

因此这里建议：

> **Implementation MVP: store URI directly.**

> **Protocol optimization later: hash in storage, URI in events.**

开发速度优先。

---

# 27. TaskStatus

建议 Solidity：

```solidity
enum TaskStatus {
    NONE,
    OPEN,
    CLAIMED,
    SUBMITTED,
    SETTLED,
    CANCELLED,
    EXPIRED
}
```

`NONE` 用于：

```text
task does not exist
```

不要使用：

```text
ACCEPTED
```

作为持久状态，

因为：

```text
acceptResult()
```

与：

```text
settlement
```

可以原子完成。

所以：

```text
SUBMITTED
↓
acceptResult()
↓
SETTLED
```

---

# 28. createTask()

TaskManager：

```solidity
function createTask(
    address requester,
    address operator,
    CreateTaskParams calldata params
)
    external
    returns (uint256 taskId);
```

这里：

```text
msg.sender
```

应该是：

```text
RequesterVault
```

而：

```text
requester
```

也可以直接：

```text
msg.sender
```

因此甚至可以去掉显式 requester 参数。

例如：

```solidity
function createTask(
    address operator,
    CreateTaskParams calldata params
)
```

记录：

```text
requester = msg.sender
```

---

# 29. 谁可以成为 Requester

如果 TaskManager 完全 permissionless：

```text
任何 address
```

都可以调用 createTask。

那普通钱包也可以直接创建 Task，

绕过 Vault。

这本身不一定有安全问题。

因为他们花的是自己的钱。

但会产生两个概念：

```text
Vault Requester

Direct Requester
```

增加协议分支。

Hackathon v0.1 建议：

> **TaskManager only accepts registered / valid RequesterVaults.**

这样数据模型单一。

---

# 30. Vault Registry

可以让 TaskManager 维护：

```solidity
mapping(address => bool)
    public approvedVaults;
```

但谁来 approve？

这会引入中心化 Registry。

更漂亮的做法是：

```text
RequesterVaultFactory
```

---

# 31. 是否需要 RequesterVaultFactory

这里有两个选择。

### Option A — 不做 Factory

Hackathon 部署：

```text
TaskManager
RequesterVault
```

TaskManager constructor 直接授权 Demo Vault。

优点：

```text
实现最快
```

缺点：

```text
Repo 不像 permissionless protocol
```

---

### Option B — 做 VaultFactory

```text
RequesterVaultFactory
       │
       ▼
RequesterVault
       │
       ▼
TaskManager
```

Factory 创建的 Vault 自动被 TaskManager 识别。

这个更适合完整 Repo。

---

# 32. 推荐：轻量 VaultFactory

建议加入第三个**非常薄的部署合约**：

```text
RequesterVaultFactory
```

不是业务核心合约。

它只负责：

```text
createVault(owner)
```

并让 TaskManager 验证：

```text
isVault(address)
```

因此架构：

```text
RequesterVaultFactory
        │
        └── creates
              │
              ▼
       RequesterVault
              │
              ▼
         TaskManager
```

---

# 33. Factory Interface

概念：

```solidity
interface IRequesterVaultFactory {
    function createVault(
        address owner
    )
        external
        returns (address vault);

    function isVault(
        address account
    )
        external
        view
        returns (bool);
}
```

TaskManager：

```text
require(
  factory.isVault(msg.sender)
)
```

---

# 34. Factory 是否可升级

Hackathon：

> 不需要 Proxy。

直接部署 immutable 合约。

如果以后 protocol evolves：

```text
VaultFactory v2
TaskManager v2
```

重新部署即可。

Hackathon 中：

```text
upgradeability
```

只会增加风险与复杂度。

---

# 35. claimTask()

Worker 直接调用：

```solidity
function claimTask(
    uint256 taskId
) external;
```

验证：

```text
Task exists

status == OPEN

block.timestamp < taskDeadline

worker != requester / operator

worker != address(0)
```

然后：

```text
task.worker = msg.sender

task.status = CLAIMED

claimLeaseExpiresAt =
min(
  now + claimLeaseSeconds,
  taskDeadline
)
```

---

# 36. Lease Clamp

非常重要：

如果：

```text
claim at 12:59
task deadline = 13:00
claimLease = 5 minutes
```

不能产生：

```text
leaseExpiresAt = 13:04
```

正确：

```text
leaseExpiresAt =
min(
  now + lease,
  taskDeadline
)
```

---

# 37. claimTask() Reentrancy

`claimTask()` 不发生 token transfer。

所以风险相对低。

状态应该：

```text
checks
↓
effects
↓
emit
```

遵循简单模式即可。

---

# 38. submitResult()

Worker：

```solidity
function submitResult(
    uint256 taskId,
    bytes32 resultHash,
    string calldata resultURI
) external;
```

检查：

```text
status == CLAIMED

msg.sender == task.worker

now <= claimLeaseExpiresAt

now <= taskDeadline

resultHash != bytes32(0)
```

然后：

```text
status = SUBMITTED

submittedAt = now

resultHash = ...

resultURI = ...
```

---

# 39. Review Deadline

无需额外存：

```text
reviewDeadline
```

可以动态计算：

```text
submittedAt
+
reviewWindowSeconds
```

避免重复 storage。

---

# 40. acceptResult()

Requester Agent 不能直接调用 TaskManager。

调用：

```text
Agent
↓
RequesterVault.acceptResult()
↓
TaskManager.acceptResult()
```

TaskManager：

```solidity
function acceptResult(
    uint256 taskId
) external;
```

要求：

```text
msg.sender == task.requester

status == SUBMITTED
```

然后：

```text
status = SETTLED
```

再：

```text
transfer reward to worker
```

---

# 41. Checks-Effects-Interactions

`acceptResult()` 发生 ERC20 Transfer。

必须：

```text
CHECKS
↓
EFFECTS
↓
INTERACTION
```

即：

```text
validate task
↓
status = SETTLED
↓
transfer reward
```

如果 Token transfer revert：

整个 transaction revert，

状态恢复为：

```text
SUBMITTED
```

不会产生：

```text
SETTLED but unpaid
```

状态。

---

# 42. SafeERC20

所有 token interaction 应使用成熟的 safe transfer wrapper，例如：

```text
SafeERC20
```

而不是假定：

```text
ERC20.transfer returns true
```

Hackathon 也应该遵守基本 Solidity 安全习惯。

---

# 43. Settlement Invariant

最重要的 Invariant：

```text
SETTLED
⇒
Reward 已经离开 TaskManager
```

并且：

```text
Reward 只能转给 assigned worker
```

不能允许：

```text
Requester 指定 recipient
```

否则 Requester 可以：

```text
accept result
↓
pay自己
```

Worker 收款地址由：

```text
task.worker
```

确定。

---

# 44. rejectResult()

Requester：

```text
Agent
↓
RequesterVault.rejectResult()
↓
TaskManager.rejectResult()
```

TaskManager：

```solidity
function rejectResult(
    uint256 taskId,
    bytes32 reasonHash
) external;
```

检查：

```text
msg.sender == requester

status == SUBMITTED

now <= reviewDeadline
```

然后：

```text
clear worker

clear result

clear lease

clear submittedAt
```

---

# 45. Reject 后状态

如果：

```text
now < taskDeadline
```

则：

```text
OPEN
```

否则：

```text
EXPIRED
```

如果直接进入 EXPIRED：

需要：

```text
refund requester
```

---

# 46. Reject 原子 Refund

例如：

```text
review happened after taskDeadline
```

Requester reject。

此时不应该：

```text
EXPIRED
```

但资金还留在 TaskManager 等下一次调用。

更好的实现：

```text
rejectResult()
↓
if deadline passed
↓
mark EXPIRED
↓
refund requester
```

在同一 transaction 完成。

---

# 47. finalize()

这是保护 Worker 的关键函数。

任何人可以调用：

```solidity
function finalize(
    uint256 taskId
) external;
```

要求：

```text
status == SUBMITTED

now > submittedAt + reviewWindow
```

然后：

```text
status = SETTLED

transfer reward to worker
```

调用者可以是：

```text
Worker

第三方 keeper

任何 address
```

不应该要求 Requester 在线。

---

# 48. 为什么 finalize() Permissionless

如果只允许 Worker：

```text
Worker process crash
```

Task 可能无法结算。

如果只允许 Requester：

就失去 optimistic settlement 意义。

所以：

```text
anyone can finalize
```

最简单、最稳健。

---

# 49. releaseExpiredClaim()

任何人：

```solidity
function releaseExpiredClaim(
    uint256 taskId
) external;
```

要求：

```text
status == CLAIMED

now > claimLeaseExpiresAt
```

如果：

```text
now < taskDeadline
```

则：

```text
clear worker
clear lease

status = OPEN
```

否则：

```text
status = EXPIRED

refund requester
```

---

# 50. expireTask()

OPEN Task 没人处理：

```solidity
function expireTask(
    uint256 taskId
) external;
```

要求：

```text
status == OPEN

now >= taskDeadline
```

然后：

```text
status = EXPIRED

refund requester
```

Permissionless。

---

# 51. 为什么 expire() Permissionless

不应该依赖：

```text
Requester
```

主动回来收钱。

任何人都能维护协议状态：

```text
deadline reached
↓
expire
↓
refund
```

Worker / keeper / Explorer 后端都可以调用。

---

# 52. cancelTask()

Requester 通过 Vault：

```solidity
function cancelTask(
    uint256 taskId
) external;
```

TaskManager 检查：

```text
msg.sender == requester

status == OPEN
```

然后：

```text
status = CANCELLED

refund requester
```

不能 Cancel：

```text
CLAIMED

SUBMITTED
```

---

# 53. Refund Recipient

所有 refund：

```text
只能回到 task.requester
```

也就是：

```text
RequesterVault
```

不能：

```text
Agent 指定退款地址
```

这样 Agent 永远无法通过：

```text
cancel
expire
reject
```

把 Owner 资金转向自己的 EOA。

---

# 54. RequesterVault acceptResult()

Vault：

```solidity
function acceptResult(
    uint256 taskId
)
    external;
```

允许：

```text
Task Operator

Owner
```

调用。

概念：

```text
if msg.sender == owner
→ allowed

else
→ must be active authorized agent
→ must equal taskOperators[taskId]
```

然后：

```text
taskManager.acceptResult(taskId)
```

---

# 55. Operator Authorization Expiry 问题

这里要处理一个边界情况。

Agent 在有效期内创建 Task。

Task 被 Worker 提交时：

```text
Agent Session expired
```

如果严格要求 Agent 当前 Authorization active，

Agent 就无法 accept。

这是合理的：

> Session 权限已经失效。

此时：

```text
Owner
```

可以 takeover。

如果 Owner 不处理，

最终：

```text
reviewWindow expires
↓
finalize()
↓
Worker paid
```

所以不会死锁。

---

# 56. rejectResult() 权限

Reject 对 Worker 影响更大。

因此：

```text
expired / revoked Agent
```

不应该继续拥有 Reject 权限。

只有：

```text
active Task Operator

或 Owner
```

可以 Reject。

这符合：

> Revoke immediately removes requester-side authority.

---

# 57. Owner Takeover

Owner 不需要：

```text
transfer task ownership
```

只需要 Vault 接口允许：

```text
owner accept

owner reject

owner cancel if OPEN
```

因此 Owner 是隐式 Root Authority。

不增加额外 Task 状态。

---

# 58. Task Operator Mapping

RequesterVault 保存：

```solidity
mapping(uint256 => address)
    public taskOperators;
```

在：

```text
createTask()
```

之后：

```text
taskOperators[taskId] = msg.sender
```

这样：

```text
Agent A
```

不能操作：

```text
Agent B
```

创建的 Task。

Owner 除外。

---

# 59. 是否需要在 TaskManager 也记录 operator

建议记录。

Task：

```solidity
address operator;
```

虽然权限实际由：

```text
RequesterVault
```

执行，

但记录 operator 有几个好处：

```text
Explorer 可见

Indexer 可查询

完整 provenance

未来 reputation / agent identity
```

所以 TaskManager 记录：

```text
requester = Vault

operator = Agent
```

---

# 60. Settlement Accounting

TaskManager 不需要维护：

```text
global escrow balance mapping
```

因为每个 Task 已经有：

```text
rewardAmount
status
```

只要确保：

```text
每个 active funded Task
```

对应一份已经存在的 Token。

但为了安全测试，

可以定义 Invariant：

```text
TaskManager Token Balance
>=
sum(
  rewardAmount of
  OPEN / CLAIMED / SUBMITTED tasks
)
```

---

# 61. 是否维护 totalEscrowed

可以维护：

```solidity
uint256 public totalEscrowed;
```

创建 Task：

```text
+= reward
```

Settlement / Refund：

```text
-= reward
```

优点：

```text
容易监控

容易做 invariant test

Explorer 可显示 TVL
```

成本极低。

建议加入。

---

# 62. totalEscrowed Invariant

始终：

```text
settlementToken.balanceOf(TaskManager)
>=
totalEscrowed
```

如果只支持单一 Token，

这很容易验证。

任何意外多余 Token：

```text
不应该由 Agent 提取
```

以后可以定义 Ownerless rescue policy，

MVP 不需要。

---

# 63. Protocol Fee

Hackathon v0.1：

```text
protocolFee = 0
```

不要现在增加：

```text
5%
fee recipient
treasury
```

它对 Demo 没有帮助，

反而使 Settlement 和 accounting 更复杂。

未来：

```text
Worker Reward
Protocol Fee
Verifier Fee
```

可以模块化扩展。

---

# 64. Worker Bond

v0.1：

```text
Worker claim 不需要 stake
```

原因：

```text
降低 Worker onboarding friction
```

坏 Worker 的主要成本是：

```text
占用 Claim Lease
```

而 Lease 已经限制 griefing。

以后如果大量攻击：

```text
Claim Bond
```

会成为自然扩展。

但不属于 Hackathon。

---

# 65. Requester Bond

Requester 已经：

```text
fully funded reward
```

因此不需要额外 Requester Bond。

---

# 66. Reentrancy Guard

涉及 ERC20 transfer 的：

```text
createTask

acceptResult

finalize

cancelTask

expireTask

reject→expire

release→expire
```

应该考虑：

```text
nonReentrant
```

虽然使用标准 USDC 风险较低，

但这是成本很小的 defense-in-depth。

RequesterVault 的：

```text
deposit

withdraw

createTask
```

同样可以保护。

---

# 67. Pause Strategy

RequesterVault 有：

```text
per-vault pause
```

TaskManager 是否需要：

```text
global pause
```

？

我建议：

> Hackathon v0.1 可以加入 emergency global pause，但权限极小化。

例如：

```text
pause new Task creation

pause new Claims
```

但不要阻止：

```text
finalize existing submission

refund expired task
```

否则 Global Pause 本身可能冻结 Worker Funds。

---

# 68. 如果做 Global Pause

应该区分：

```text
Risk Increasing Actions
```

和：

```text
Risk Reducing Actions
```

Pause 时禁止：

```text
createTask

claimTask
```

仍允许：

```text
acceptResult

finalize

expireTask

releaseExpiredClaim

refund paths
```

这样协议可以安全 unwind。

---

# 69. 是否需要 Admin

如果 TaskManager 支持 global pause，

需要：

```text
protocol admin
```

Hackathon 可以：

```text
deployer multisig / owner EOA
```

但 README 必须明确：

```text
Admin can pause new activity
```

不要声称完全 trustless。

如果想保持更简洁：

> v0.1 TaskManager 无 Admin、无 Upgrade、无 Pause。

RequesterVault 自己有 Pause。

我更倾向这个方案。

---

# 70. 推荐：TaskManager 无管理员

这样：

```text
TaskManager
=
immutable protocol state machine
```

部署后：

```text
没有 upgrade

没有 owner

没有 arbitrary rescue

没有 admin settlement
```

非常适合 Hackathon Story。

而：

```text
RequesterVault
```

由各自 Owner 管理。

形成：

```text
Protocol Layer
→ neutral

Account Layer
→ owner controlled
```

---

# 71. RequesterVaultFactory 管理问题

Factory 也不需要 Admin。

它只：

```text
create vault
record vault
```

例如：

```solidity
mapping(address => bool)
public isVault;
```

一旦 Vault 创建：

```text
true forever
```

即使 Owner 不再使用也没问题。

---

# 72. Factory / Manager Circular Dependency

部署顺序需要注意：

```text
TaskManager needs Factory
Factory needs TaskManager
Vault needs TaskManager
```

可以设计成：

```text
Deploy TaskManager with factory address
```

但 factory 还没创建。

解决方式很多。

Hackathon 推荐更简单：

### Option 1

TaskManager 不验证 Factory。

任何 caller 都能创建 funded Task。

RequesterVault 只是推荐账户层。

这是最简单。

---

# 73. 我建议重新考虑 Vault Registry

事实上：

```text
Direct Requester
```

并不会破坏协议安全。

如果一个普通 EOA 调用：

```text
TaskManager.createTask()
```

只要：

```text
transferFrom caller
```

成功，

这个 Task 也是 fully funded。

因此 TaskManager 完全可以：

> **permissionless requester entry.**

RequesterVault 只是我们提供的安全 Agent Account。

这样反而更符合开放协议。

---

# 74. 推荐最终设计：TaskManager Permissionless

任何地址都可以：

```text
createTask()
```

如果普通 EOA：

```text
requester = EOA
operator = EOA
```

如果 Vault：

```text
requester = Vault
operator = Agent
```

问题只剩：

> TaskManager 怎么知道 operator？

可以让：

```solidity
createTask(
  address operator,
  ...
)
```

但普通 EOA 也能随便写 operator。

这并不影响资金安全。

operator 只是 metadata。

---

# 75. Requester Authority 由 requester 决定

TaskManager **只信任 requester address**。

也就是说：

```text
acceptResult()
```

只要求：

```text
msg.sender == task.requester
```

至于：

```text
RequesterVault
```

内部是否允许 Agent 操作，

那是 Vault 自己的事情。

这正好形成漂亮的抽象：

```text
TaskManager
does not know Agents
```

它只知道：

```text
Requester Contract / Address
Worker Address
```

---

# 76. 这个抽象非常重要

最终：

```text
TaskManager
```

根本不需要知道：

```text
Owner

Agent Authorization

Session Budget
```

它只知道：

```text
Requester created a funded Task.
```

Requester 可以是：

```text
EOA

RequesterVault

Safe

Smart Account

EIP-7702 account

DAO
```

于是协议自然变得 account-model agnostic。

---

# 77. createTaskFrom Vault

Vault 调用：

```solidity
taskManager.createTask(
    operator,
    params
)
```

TaskManager：

```text
requester = msg.sender
operator = supplied operator
```

然后：

```text
pull reward from msg.sender
```

普通用户：

```solidity
taskManager.createTask(
    msg.sender,
    params
)
```

也一样工作。

---

# 78. 为什么这比 Factory 更好

这样我们可以删除：

```text
RequesterVaultFactory
```

作为协议依赖。

Repo 仍可以提供：

```text
VaultFactory
```

方便部署，

但 TaskManager 不依赖它。

最终核心协议只有：

```text
TaskManager
```

账户安全扩展：

```text
RequesterVault
```

这其实更干净。

---

# 79. 最终 Smart Contract 边界

因此建议最终锁定：

```text
contracts/
├── TaskManager.sol
├── RequesterVault.sol
├── interfaces/
│   ├── ITaskManager.sol
│   └── IRequesterVault.sol
└── libraries/
    └── TaskTypes.sol
```

可选：

```text
RequesterVaultFactory.sol
```

仅作为 deployment convenience。

---

# 80. TaskManager 核心接口

概念：

```solidity
interface ITaskManager {

    function createTask(
        address operator,
        CreateTaskParams calldata params
    )
        external
        returns (uint256 taskId);

    function claimTask(
        uint256 taskId
    ) external;

    function submitResult(
        uint256 taskId,
        bytes32 resultHash,
        string calldata resultURI
    ) external;

    function acceptResult(
        uint256 taskId
    ) external;

    function rejectResult(
        uint256 taskId,
        bytes32 reasonHash
    ) external;

    function finalize(
        uint256 taskId
    ) external;

    function releaseExpiredClaim(
        uint256 taskId
    ) external;

    function cancelTask(
        uint256 taskId
    ) external;

    function expireTask(
        uint256 taskId
    ) external;
}
```

---

# 81. RequesterVault 核心接口

```solidity
interface IRequesterVault {

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
        CreateTaskParams calldata params
    )
        external
        returns (uint256 taskId);

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
}
```

---

# 82. RequesterVault 与 TaskManager Approval

Vault 初始化时：

```text
settlementToken.approve(
  TaskManager,
  max
)
```

但 Solidity constructor 中 Token Approval 要谨慎处理。

也可以提供：

```text
initializeAllowance()
```

Owner 调一次。

Hackathon 可采用 constructor 完成固定 allowance。

---

# 83. Direct Requester Approval

普通 EOA 如果直接用 TaskManager：

需要：

```text
USDC.approve(TaskManager, reward)
```

然后：

```text
createTask()
```

Requester SDK 对 Vault 模式可以隐藏这个差异。

---

# 84. Task Getter

TaskManager：

```solidity
function getTask(
    uint256 taskId
)
    external
    view
    returns (Task memory);
```

虽然：

```text
mapping public
```

会自动生成 getter，

但显式 `getTask()` 对 SDK 更友好，

尤其 Struct 有 dynamic fields 时。

---

# 85. isClaimActive()

可以提供 view helper：

```solidity
function isClaimActive(
    uint256 taskId
)
    external
    view
    returns (bool);
```

但不是必要。

SDK 自己也可以根据：

```text
status
leaseExpiresAt
```

判断。

MVP 尽量少写 helper。

---

# 86. canFinalize()

类似：

```text
submittedAt + reviewWindow
```

也可由 SDK 自己计算。

Contract API 保持最小。

---

# 87. Events

建议：

```solidity
event TaskCreated(
    uint256 indexed taskId,
    address indexed requester,
    address indexed operator,
    bytes32 capabilityId,
    uint256 rewardAmount,
    bytes32 specHash,
    string specURI,
    uint256 taskDeadline
);
```

---

# 88. TaskClaimed

```solidity
event TaskClaimed(
    uint256 indexed taskId,
    address indexed worker,
    uint256 leaseExpiresAt
);
```

---

# 89. ResultSubmitted

```solidity
event ResultSubmitted(
    uint256 indexed taskId,
    address indexed worker,
    bytes32 resultHash,
    string resultURI,
    uint256 reviewDeadline
);
```

---

# 90. ResultRejected

```solidity
event ResultRejected(
    uint256 indexed taskId,
    address indexed requester,
    address indexed worker,
    bytes32 reasonHash
);
```

注意：

即使 Reject 后 `worker` 被清空，

Event 仍保留原 Worker。

---

# 91. TaskSettled

```solidity
event TaskSettled(
    uint256 indexed taskId,
    address indexed requester,
    address indexed worker,
    uint256 rewardAmount
);
```

---

# 92. TaskCancelled

```solidity
event TaskCancelled(
    uint256 indexed taskId,
    address indexed requester
);
```

---

# 93. TaskExpired

```solidity
event TaskExpired(
    uint256 indexed taskId,
    address indexed requester,
    uint256 refundedAmount
);
```

---

# 94. ClaimReleased

建议额外：

```solidity
event ClaimReleased(
    uint256 indexed taskId,
    address indexed worker
);
```

这样 Worker / Explorer 可以区分：

```text
Task reopened due to timeout
```

而不是只看到新的 OPEN 状态。

---

# 95. Vault Events

```solidity
event AgentAuthorized(
    address indexed agent,
    uint256 maxPerTask,
    uint256 maxTotalCommitment,
    uint256 validUntil
);
```

```solidity
event AgentRevoked(
    address indexed agent
);
```

```solidity
event VaultDeposited(
    uint256 amount
);
```

```solidity
event VaultWithdrawn(
    uint256 amount
);
```

---

# 96. Custom Errors

不要大量使用：

```solidity
require(
  condition,
  "long error string"
)
```

建议 custom errors：

```solidity
error TaskNotFound();

error InvalidTaskState();

error TaskExpired();

error ClaimExpired();

error NotAssignedWorker();

error NotRequester();

error InvalidResultHash();

error RewardExceedsLimit();

error SessionBudgetExceeded();

error AuthorizationExpired();

error UnauthorizedAgent();
```

优点：

```text
gas 更低

SDK 更容易 decode

MCP 更容易变成人类可理解错误
```

---

# 97. State Transition Enforcement

Smart Contract 必须是状态机的最终执法者。

不能依赖 SDK：

```text
“SDK normally won't call this.”
```

例如 `submitResult()` 必须自己检查：

```text
CLAIMED
```

`acceptResult()` 必须自己检查：

```text
SUBMITTED
```

`cancelTask()` 必须自己检查：

```text
OPEN
```

即使恶意用户绕过 SDK 直接调用 Contract，

也不能破坏状态机。

---

# 98. Full State Machine

```text
                  create
                    │
                    ▼
                  OPEN
              ┌─────┼─────┐
              │     │     │
          claim   cancel  deadline
              │     │     │
              ▼     ▼     ▼
          CLAIMED CANCELLED EXPIRED
              │
          submit
              │
              ▼
         SUBMITTED
          │      │
     accept      reject
          │      │
          ▼      ▼
      SETTLED   OPEN
          ▲
          │
 review window
   expires
          │
       finalize
```

以及：

```text
CLAIMED
   │
lease expires
   │
   ├── before task deadline → OPEN
   │
   └── after task deadline  → EXPIRED
```

---

# 99. Funds State Machine

Task funds 同时有自己的隐含状态：

```text
Vault
  │
create
  ▼
Escrow
  │
  ├── success → Worker
  │
  ├── cancel  → Requester
  │
  └── expire  → Requester
```

资金不允许：

```text
Escrow
↓
Agent Operator
```

这是非常重要的 invariant。

---

# 100. Economic Invariant 1

每个：

```text
OPEN
CLAIMED
SUBMITTED
```

Task：

```text
Reward 必须仍然处于 Escrow。
```

---

# 101. Economic Invariant 2

每个：

```text
SETTLED
```

Task：

```text
Reward 必须已经支付给 Worker。
```

---

# 102. Economic Invariant 3

每个：

```text
CANCELLED
EXPIRED
```

Task：

```text
Reward 必须已经退回 Requester。
```

---

# 103. Economic Invariant 4

一个 Task 的 Reward：

```text
最多移动一次。
```

---

# 104. Economic Invariant 5

Requester 在 Task 已：

```text
CLAIMED
```

后不能单方面把 Reward 拿回。

---

# 105. Authorization Invariant

RequesterVault 中：

```text
agent commitment
<=
maxTotalCommitment
```

永久成立。

并且：

```text
reward
<=
maxPerTask
```

对每一份由 Agent 创建的 Task 成立。

---

# 106. Time Invariants

创建 Task：

```text
taskDeadline > now
```

Claim：

```text
now < taskDeadline
```

Submit：

```text
now <= claimLeaseExpiresAt
```

Finalize：

```text
now > reviewDeadline
```

所有时间判断应统一使用：

```text
block.timestamp
```

MVP 不需要更复杂 Clock abstraction。

---

# 107. Result Hash Invariant

一旦进入：

```text
SUBMITTED
```

当前 Submission：

```text
resultHash
```

不能被 Worker 修改。

若 Reject：

```text
clear
```

下一位 Worker 才能提交新的 Result。

Worker 不能：

```text
submitResult()
submitResult()
submitResult()
```

不断覆盖。

---

# 108. Worker Assignment Invariant

同一时间：

```text
每个 Task 最多只有一个 active worker。
```

由：

```text
OPEN → CLAIMED
```

的原子状态变化保证。

---

# 109. Access Control Matrix

| Action                | Agent Operator | Vault Owner |        Worker |      Anyone |
| --------------------- | -------------: | ----------: | ------------: | ----------: |
| Create Task via Vault |              ✓ |    optional |             — |           — |
| Authorize Agent       |              — |           ✓ |             — |           — |
| Revoke Agent          |              — |           ✓ |             — |           — |
| Withdraw Vault        |              — |           ✓ |             — |           — |
| Claim Task            |              — |           — |             ✓ | ✓ as worker |
| Submit Result         |              — |           — | assigned only |           — |
| Accept Result         |              ✓ |           ✓ |             — |           — |
| Reject Result         |              ✓ |           ✓ |             — |           — |
| Cancel OPEN Task      |              ✓ |           ✓ |             — |           — |
| Finalize timeout      |              — |           — |             ✓ |           ✓ |
| Release expired claim |              — |           — |             ✓ |           ✓ |
| Expire OPEN Task      |              — |           — |             ✓ |           ✓ |

其中 Requester 操作最终由：

```text
task.requester
```

在 TaskManager 层验证。

---

# 110. Solidity Testing

合约必须有：

```text
unit tests
```

以及：

```text
invariant / fuzz tests
```

尤其状态机非常适合 Fuzz。

---

# 111. Unit Tests

至少覆盖：

```text
create funded task

unauthorized agent cannot create

reward > maxPerTask rejected

session budget exceeded

claim task

double claim fails

non-worker submit fails

expired worker submit fails

accept pays worker

reject reopens

review timeout finalizes

claim timeout reopens

task deadline refunds

cancel only OPEN

double settlement impossible

revoked agent loses authority
```

---

# 112. Fuzz / Invariant Tests

最重要几个：

```text
totalEscrowed
<=
token.balanceOf(TaskManager)
```

```text
terminal Task
cannot return to active state
```

```text
Task reward
cannot settle twice
```

```text
non-requester
cannot accept or reject
```

```text
non-worker
cannot submit
```

```text
Vault committed
never exceeds session limit
```

---

# 113. End-to-End Contract Test

真实测试：

```text
Owner
↓
fund Vault

Owner
↓
authorize Agent

Agent
↓
create Task

Worker
↓
claim

Worker
↓
submit

Agent
↓
accept

Worker
↓
USDC balance increases
```

这是最核心测试。

---

# 114. Failure E2E

还必须验证：

```text
Worker claim
↓
timeout
↓
another Worker claim
↓
submit
↓
settle
```

以及：

```text
Worker submit
↓
Requester offline
↓
review window
↓
Worker finalize
↓
paid
```

这两个 Demo 失败路径会让协议可信度大幅提高。

---

# 115. Gas 优化优先级

Hackathon 阶段：

> **correctness > readability > gas optimization**

不要为了减少几个 storage slots 把代码变得难审计。

可以做的简单优化：

```text
compact integer types

custom errors

immutable addresses

avoid unnecessary arrays
```

但不要：

```text
assembly-heavy implementation
```

---

# 116. No Upgradeability

v0.1：

```text
No Proxy

No Upgradeable Storage

No Delegatecall
```

优点：

```text
代码容易理解

安全边界清楚

评委容易审阅

部署结果不可变
```

对于 Hackathon 项目非常合适。

---

# 117. No Arbitrary Calls

两份核心合约都不应该包含：

```text
execute(address, bytes)
```

也不要：

```text
delegatecall
```

协议应该完全 semantic。

这是整个安全模型的重要部分。

---

# 118. No Oracle Dependency

v0.1 不需要价格 Oracle。

因为：

```text
Reward = fixed USDC amount
```

不存在：

```text
MON/USD conversion
```

或者：

```text
variable protocol pricing
```

---

# 119. No NFT / Token

不要为了 Hackathon 做：

```text
Task NFT

Agent Token

Reputation Token
```

Task identity：

```text
uint256 taskId
```

已经足够。

---

# 120. Monad-specific Story

合约本身应该保持：

```text
EVM-compatible
```

而不是为了 Monad 写一堆 chain-specific Solidity。

Monad 的价值主要体现在：

```text
大量 Task Lifecycle Transactions

大量 Worker Nodes

大量小额 Escrow

大量 Settlement
```

即：

```text
Agent economic coordination
```

本身可以频繁上链。

这比做一个：

```text
Monad-only Solidity trick
```

更贴合我们的产品 Story。

---

# 121. Contract Deployment

Hackathon 部署最少：

```text
USDC
(existing deployment)

TaskManager

RequesterVault
```

Owner：

```text
EOA
```

Agent：

```text
Session EOA
```

Worker：

```text
Worker EOA
```

---

# 122. Deployment Script

Repo：

```text
contracts/
├── src/
├── test/
└── script/
    ├── DeployTaskManager.s.sol
    └── DeployDemoVault.s.sol
```

或者 Hardhat / Foundry 对应脚本。

部署后生成：

```json
{
  "chainId": "...",
  "settlementToken": "0x...",
  "taskManager": "0x...",
  "requesterVault": "0x..."
}
```

供：

```text
Requester SDK
Worker SDK
MCP
Explorer
```

共同读取。

---

# 123. Contract Metadata Package

建议：

```text
packages/contracts/
```

发布：

```text
ABI
addresses
chain config
```

例如：

```ts
import {
  taskManagerAbi,
  deployments
} from "@project/contracts";
```

不要：

```text
每个 package 手动复制 ABI JSON。
```

---

# 124. Recommended Repo Layout

```text
contracts/
├── src/
│   ├── TaskManager.sol
│   ├── RequesterVault.sol
│   │
│   ├── interfaces/
│   │   ├── ITaskManager.sol
│   │   └── IRequesterVault.sol
│   │
│   └── libraries/
│       └── TaskTypes.sol
│
├── test/
│   ├── TaskManager.t.sol
│   ├── RequesterVault.t.sol
│   ├── Integration.t.sol
│   └── Invariants.t.sol
│
└── script/
    └── Deploy.s.sol
```

可选：

```text
RequesterVaultFactory.sol
```

作为 convenience，不属于 Core Protocol dependency。

---

# 125. MVP 实现范围

Hackathon 必须实现：

### TaskManager

```text
createTask

claimTask

submitResult

acceptResult

rejectResult

finalize

releaseExpiredClaim

cancelTask

expireTask

getTask

events

totalEscrowed
```

### RequesterVault

```text
deposit

withdraw

authorizeAgent

revokeAgent

createTask

acceptResult

rejectResult

cancelTask
```

### Security

```text
SafeERC20

custom errors

nonReentrant

immutable config

no arbitrary execute
```

### Tests

```text
happy path

timeout

reject

refund

revoke

budget limits

double settlement protection
```

---

# 126. Hackathon 延后

暂时不实现：

```text
Upgradeable contracts

Protocol fee

Worker staking

Requester staking

Dispute court

Verifier rewards

Partial payments

Milestone tasks

Streaming settlement

Multi-worker task

Auction

Reputation registry

Task NFT

Private task encryption

EIP-7702 wallet implementation

Cross-chain settlement
```

---

# 127. 本文锁定的设计决策

Smart Contract v0.1 暂时锁定：

1. 核心协议只有 `TaskManager`；
2. `RequesterVault` 是推荐的 Agent Account Layer；
3. Settlement 逻辑并入 `TaskManager`；
4. TaskManager 可以 permissionless 接受 Requester；
5. Requester 可以是 Vault、EOA、Smart Account 等；
6. TaskManager 只信任 `task.requester`；
7. Agent Authorization 不进入 TaskManager；
8. Vault 固定 Settlement Token；
9. Vault 固定 TaskManager；
10. Agent 没有 arbitrary execute；
11. Reward 创建 Task 时完整 Escrow；
12. Escrow 位于 TaskManager；
13. Settlement 原子发生；
14. Refund 永远返回 Requester；
15. Worker payment 永远支付 assigned Worker；
16. `accept` 与 `settlement` 是同一个状态转换；
17. Review Window 到期后任何人可 `finalize`；
18. Claim Lease 到期后任何人可释放；
19. Deadline 到期后任何人可触发 Refund；
20. TaskManager 不需要 Owner / Admin / Upgrade；
21. RequesterVault 由 Owner 控制；
22. Contract 不依赖 Oracle；
23. Contract 不依赖 Worker Registry；
24. Contract 不依赖 Indexer；
25. Protocol Fee v0.1 = 0；
26. URI 可以 MVP 存链，未来改为 Event-only；
27. Solidity 合约保持 EVM-native，Monad 优势来自高频 Agent coordination。

---

# 128. 最终合约抽象

整个链上系统最终可以压缩成：

```text
                OWNER
                  │
                  ▼
          RequesterVault
         capital + policy
                  │
                  ▼
             TaskManager
       ┌──────────┼──────────┐
       │          │          │
       ▼          ▼          ▼
    Request     Commit      Escrow
                  │
                  ▼
                Worker
                  │
               Submit
                  │
                  ▼
                Verify
              /        \
             /          \
         Accept        Expire
           │             │
           ▼             ▼
        Worker        Requester
         paid          refund
```

`RequesterVault` 回答：

> **Can this Agent spend this money?**

`TaskManager` 回答：

> **Given that the money has been committed, what must happen before it can move?**

两者组合之后，整个系统形成一个非常清晰的安全边界：

> **The Agent decides.**

> **The Vault limits.**

> **The Task contract enforces.**

> **Monad settles.**
