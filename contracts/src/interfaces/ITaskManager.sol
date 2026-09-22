// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {TaskTypes} from "../libraries/TaskTypes.sol";

interface ITaskManager {
    error TaskNotFound(uint256 taskId);
    error InvalidState(TaskTypes.Status actual);
    error InvalidParameters();
    error NotRequester();
    error NotAssignedWorker();
    error DeadlineReached();
    error DeadlineNotReached();
    error AttemptMismatch(uint64 expected, uint64 actual);
    error ResultHashMismatch();
    error RequestIdConflict(bytes32 clientRequestId);
    error IncorrectTokenAmount();
    error InvalidJudgeSet();
    error InvalidVerdictCount();
    error UnknownJudge(address signer);
    error DuplicateJudge();

    event TaskCreated(
        uint256 indexed taskId, address indexed requester, bytes32 indexed clientRequestId,
        address operator, TaskTypes.CreateTaskParams params
    );
    event TaskClaimed(uint256 indexed taskId, address indexed worker, uint64 attempt, uint64 leaseExpiresAt);
    event ResultSubmitted(
        uint256 indexed taskId, address indexed worker, uint64 attempt,
        bytes32 resultHash, string resultURI, uint64 submittedAt, uint64 reviewDeadline
    );
    event ResultRejected(
        uint256 indexed taskId, address indexed worker, uint64 attempt,
        bytes32 resultHash, bytes32 reasonHash
    );
    event ClaimReleased(uint256 indexed taskId, address indexed worker, uint64 attempt);
    event TaskReopened(uint256 indexed taskId, uint64 previousAttempt);
    event TaskSettled(
        uint256 indexed taskId, address indexed requester, address indexed worker,
        uint64 attempt, bytes32 resultHash, uint128 amount, TaskTypes.SettlementReason reason
    );
    event TaskCancelled(uint256 indexed taskId, address indexed requester, uint128 refundedAmount);
    event TaskExpired(uint256 indexed taskId, address indexed requester, uint128 refundedAmount);
    event VerdictSettled(
        uint256 indexed taskId, address indexed worker, uint16 medianBps, uint128 workerAmount, uint128 refundAmount
    );

    function settlementToken() external view returns (address);
    function totalEscrowed() external view returns (uint256);
    function judges(uint256 index) external view returns (address);
    function isJudge(address account) external view returns (bool);
    function judgeThreshold() external view returns (uint8);
    function createTask(bytes32 clientRequestId, address operator, TaskTypes.CreateTaskParams calldata params)
        external returns (uint256 taskId);
    function claimTask(uint256 taskId) external returns (uint64 attempt);
    function submitResult(uint256 taskId, uint64 expectedAttempt, bytes32 resultHash, string calldata resultURI) external;
    function acceptResult(uint256 taskId, uint64 expectedAttempt, bytes32 expectedResultHash) external;
    function rejectResult(uint256 taskId, uint64 expectedAttempt, bytes32 expectedResultHash, bytes32 reasonHash) external;
    function finalize(uint256 taskId) external;
    function settleWithVerdicts(
        uint256 taskId, uint64 expectedAttempt, bytes32 expectedResultHash,
        uint16[] calldata completionBps, bytes[] calldata signatures
    ) external;
    function releaseExpiredClaim(uint256 taskId) external;
    function expireTask(uint256 taskId) external;
    function cancelTask(uint256 taskId) external;
    function getTask(uint256 taskId) external view returns (TaskTypes.Task memory);
    function getTaskByRequestId(address requester, bytes32 clientRequestId) external view returns (uint256);
    function getRequestParamsHash(address requester, bytes32 clientRequestId) external view returns (bytes32);
}
