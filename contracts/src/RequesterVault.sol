// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRequesterVault} from "./interfaces/IRequesterVault.sol";
import {ITaskManager} from "./interfaces/ITaskManager.sol";
import {TaskTypes} from "./libraries/TaskTypes.sol";
import {TaskRules} from "./libraries/TaskRules.sol";

contract RequesterVault is IRequesterVault, ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable owner;
    address public immutable taskManager;
    address public immutable settlementToken;
    bool public paused;
    mapping(address => TaskTypes.AgentAuthorization) private authorizations;
    mapping(uint256 => TaskTypes.TaskAuthority) private taskAuthorities;

    constructor(address owner_, address manager, address token) {
        if (owner_ == address(0) || manager.code.length == 0 || token.code.length == 0 ||
            ITaskManager(manager).settlementToken() != token) revert InvalidAuthorization();
        owner = owner_; taskManager = manager; settlementToken = token;
    }
    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    function getAuthorization(address agent) external view returns (TaskTypes.AgentAuthorization memory) { return authorizations[agent]; }
    function getTaskAuthority(uint256 id) external view returns (TaskTypes.TaskAuthority memory) { return taskAuthorities[id]; }
    function deposit(uint256 amount) external nonReentrant {
        IERC20 token = IERC20(settlementToken); uint256 before_ = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) != before_ + amount) revert InvalidAuthorization();
        emit Deposited(msg.sender, amount);
    }
    function withdraw(uint256 amount, address recipient) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert InvalidAuthorization();
        IERC20(settlementToken).safeTransfer(recipient, amount); emit Withdrawn(recipient, amount);
    }
    function authorizeAgent(address agent, TaskTypes.AuthorizationParams calldata p) external onlyOwner {
        if (agent == address(0) || p.validAfter >= p.validUntil || p.validUntil <= block.timestamp ||
            p.maxPerTask == 0 || p.maxPerTask > p.maxTotalCommitment) revert InvalidAuthorization();
        uint64 epoch = authorizations[agent].epoch + 1;
        authorizations[agent] = TaskTypes.AgentAuthorization(true, epoch, p.validAfter, p.validUntil, p.maxPerTask, p.maxTotalCommitment, 0);
        emit AgentAuthorized(agent, epoch, p);
    }
    function revokeAgent(address agent) external onlyOwner {
        TaskTypes.AgentAuthorization storage a = authorizations[agent]; a.active = false; ++a.epoch;
        emit AgentRevoked(agent, a.epoch);
    }
    function setPaused(bool value) external onlyOwner { paused = value; emit PausedChanged(value); }
    function createTask(bytes32 requestId, TaskTypes.CreateTaskParams calldata p) external nonReentrant returns (uint256 id) {
        TaskTypes.AgentAuthorization storage a = _agent();
        ITaskManager manager = ITaskManager(taskManager);
        id = manager.getTaskByRequestId(address(this), requestId);
        if (id != 0) {
            TaskTypes.TaskAuthority storage authority = taskAuthorities[id];
            if (authority.operator != msg.sender || authority.epoch != a.epoch) revert InvalidTaskAuthority();
            if (manager.getRequestParamsHash(address(this), requestId) != TaskRules.hashCreateParams(msg.sender, p)) revert RequestIdConflict(requestId);
            return id;
        }
        if (p.rewardAmount > a.maxPerTask) revert RewardExceedsLimit();
        if (uint256(a.committed) + p.rewardAmount > a.maxTotalCommitment) revert SessionBudgetExceeded();
        if (uint256(p.taskDeadline) + p.reviewWindowSeconds >= a.validUntil) revert SessionTooShort();
        a.committed += p.rewardAmount;
        IERC20 token = IERC20(settlementToken);
        token.forceApprove(taskManager, p.rewardAmount);
        id = manager.createTask(requestId, msg.sender, p);
        token.forceApprove(taskManager, 0);
        taskAuthorities[id] = TaskTypes.TaskAuthority(msg.sender, a.epoch);
        emit TaskAuthorityRecorded(id, msg.sender, a.epoch);
    }
    function acceptResult(uint256 id, uint64 attempt, bytes32 hash) external nonReentrant {
        _authority(id); ITaskManager(taskManager).acceptResult(id, attempt, hash);
    }
    function rejectResult(uint256 id, uint64 attempt, bytes32 hash, bytes32 reason) external nonReentrant {
        _authority(id); ITaskManager(taskManager).rejectResult(id, attempt, hash, reason);
    }
    function cancelTask(uint256 id) external nonReentrant { _authority(id); ITaskManager(taskManager).cancelTask(id); }
    function _agent() private view returns (TaskTypes.AgentAuthorization storage a) {
        if (paused) revert VaultPaused();
        a = authorizations[msg.sender];
        if (!a.active || block.timestamp < a.validAfter || block.timestamp >= a.validUntil) revert UnauthorizedAgent();
    }
    function _authority(uint256 id) private view {
        if (msg.sender == owner) return;
        TaskTypes.AgentAuthorization storage a = _agent();
        TaskTypes.TaskAuthority storage authority = taskAuthorities[id];
        if (authority.operator != msg.sender || authority.epoch != a.epoch) revert InvalidTaskAuthority();
    }
}
