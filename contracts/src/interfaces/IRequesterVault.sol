// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {TaskTypes} from "../libraries/TaskTypes.sol";

interface IRequesterVault {
    error NotOwner();
    error InvalidAuthorization();
    error UnauthorizedAgent();
    error InvalidTaskAuthority();
    error RewardExceedsLimit();
    error SessionBudgetExceeded();
    error SessionTooShort();
    error VaultPaused();
    error RequestIdConflict(bytes32 clientRequestId);

    event Deposited(address indexed sender, uint256 amount);
    event Withdrawn(address indexed recipient, uint256 amount);
    event AgentAuthorized(address indexed agent, uint64 epoch, TaskTypes.AuthorizationParams params);
    event AgentRevoked(address indexed agent, uint64 epoch);
    event TaskAuthorityRecorded(uint256 indexed taskId, address indexed operator, uint64 epoch);
    event PausedChanged(bool paused);

    function owner() external view returns (address);
    function taskManager() external view returns (address);
    function settlementToken() external view returns (address);
    function paused() external view returns (bool);
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount, address recipient) external;
    function authorizeAgent(address agent, TaskTypes.AuthorizationParams calldata params) external;
    function revokeAgent(address agent) external;
    function setPaused(bool value) external;
    function getAuthorization(address agent) external view returns (TaskTypes.AgentAuthorization memory);
    function getTaskAuthority(uint256 taskId) external view returns (TaskTypes.TaskAuthority memory);
    function createTask(bytes32 clientRequestId, TaskTypes.CreateTaskParams calldata params)
        external returns (uint256 taskId);
    function acceptResult(uint256 taskId, uint64 expectedAttempt, bytes32 expectedResultHash) external;
    function rejectResult(uint256 taskId, uint64 expectedAttempt, bytes32 expectedResultHash, bytes32 reasonHash) external;
    function cancelTask(uint256 taskId) external;
}
