// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ITaskManager} from "./interfaces/ITaskManager.sol";
import {TaskTypes} from "./libraries/TaskTypes.sol";
import {TaskRules} from "./libraries/TaskRules.sol";

contract TaskManager is ITaskManager, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 private constant VERDICT_TYPEHASH =
        keccak256("Verdict(uint256 taskId,uint64 attempt,bytes32 resultHash,uint16 completionBps)");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private immutable _verdictDomain;

    address public immutable settlementToken;
    uint256 public totalEscrowed;
    uint256 public nextTaskId = 1;
    address[] public judges;
    mapping(address => bool) public isJudge;
    uint8 public judgeThreshold;
    mapping(uint256 => TaskTypes.Task) private tasks;
    mapping(address => mapping(bytes32 => uint256)) private requests;
    mapping(address => mapping(bytes32 => bytes32)) private requestHashes;

    constructor(address token, address[] memory judges_, uint8 threshold) {
        if (token.code.length == 0) revert InvalidParameters();
        settlementToken = token;
        _verdictDomain = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH, keccak256("WorknetJudge"), keccak256("1"), block.chainid, address(this)
        ));
        if (judges_.length == 0 || threshold < 1 || threshold > judges_.length) revert InvalidJudgeSet();
        for (uint256 i = 0; i < judges_.length; i++) {
            address judge = judges_[i];
            if (judge == address(0)) revert InvalidJudgeSet();
            if (isJudge[judge]) revert DuplicateJudge();
            isJudge[judge] = true; judges.push(judge);
        }
        judgeThreshold = threshold;
    }

    function getTask(uint256 id) external view returns (TaskTypes.Task memory) { return _task(id); }
    function getTaskByRequestId(address requester, bytes32 id) external view returns (uint256) { return requests[requester][id]; }
    function getRequestParamsHash(address requester, bytes32 id) external view returns (bytes32) { return requestHashes[requester][id]; }

    function createTask(bytes32 requestId, address operator, TaskTypes.CreateTaskParams calldata p)
        external nonReentrant returns (uint256 id)
    {
        bytes32 paramsHash = TaskRules.hashCreateParams(operator, p);
        id = requests[msg.sender][requestId];
        if (id != 0) {
            if (requestHashes[msg.sender][requestId] != paramsHash) revert RequestIdConflict(requestId);
            return id;
        }
        if (requestId == 0 || operator == address(0) || p.capabilityId == 0 || p.specHash == 0 ||
            p.rewardAmount == 0 || bytes(p.specURI).length == 0 || bytes(p.specURI).length > TaskTypes.MAX_URI_BYTES ||
            p.taskDeadline <= block.timestamp || p.taskDeadline - block.timestamp > TaskTypes.MAX_TASK_LIFETIME ||
            p.claimLeaseSeconds == 0 || p.claimLeaseSeconds > p.taskDeadline - block.timestamp ||
            p.reviewWindowSeconds < TaskTypes.MIN_REVIEW_WINDOW || p.reviewWindowSeconds > TaskTypes.MAX_REVIEW_WINDOW ||
            p.taskDeadline > type(uint64).max - p.reviewWindowSeconds) revert InvalidParameters();
        id = nextTaskId++;
        TaskTypes.Task storage t = tasks[id];
        t.requester = msg.sender; t.operator = operator; t.rewardAmount = p.rewardAmount;
        t.capabilityId = p.capabilityId; t.specHash = p.specHash; t.specURI = p.specURI;
        t.taskDeadline = p.taskDeadline; t.claimLeaseSeconds = p.claimLeaseSeconds; t.reviewWindowSeconds = p.reviewWindowSeconds;
        requests[msg.sender][requestId] = id; requestHashes[msg.sender][requestId] = paramsHash;
        totalEscrowed += p.rewardAmount;
        IERC20 token = IERC20(settlementToken);
        uint256 before_ = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), p.rewardAmount);
        if (token.balanceOf(address(this)) != before_ + p.rewardAmount) revert IncorrectTokenAmount();
        emit TaskCreated(id, msg.sender, requestId, operator, p);
    }

    function claimTask(uint256 id) external nonReentrant returns (uint64 attempt) {
        TaskTypes.Task storage t = _task(id); _state(t, TaskTypes.Status.OPEN);
        if (block.timestamp >= t.taskDeadline) revert DeadlineReached();
        t.worker = msg.sender; t.status = TaskTypes.Status.CLAIMED; attempt = ++t.attempt;
        t.claimLeaseExpiresAt = TaskRules.leaseExpiry(uint64(block.timestamp), t.claimLeaseSeconds, t.taskDeadline);
        emit TaskClaimed(id, msg.sender, attempt, t.claimLeaseExpiresAt);
    }

    function submitResult(uint256 id, uint64 attempt, bytes32 hash, string calldata uri) external nonReentrant {
        TaskTypes.Task storage t = _task(id); _state(t, TaskTypes.Status.CLAIMED);
        if (msg.sender != t.worker) revert NotAssignedWorker();
        _attempt(t, attempt);
        if (!TaskRules.canSubmit(uint64(block.timestamp), t.claimLeaseExpiresAt, t.taskDeadline)) revert DeadlineReached();
        if (hash == 0 || bytes(uri).length == 0 || bytes(uri).length > TaskTypes.MAX_URI_BYTES) revert InvalidParameters();
        t.status = TaskTypes.Status.SUBMITTED; t.resultHash = hash; t.resultURI = uri;
        t.submittedAt = uint64(block.timestamp); t.reviewDeadline = uint64(block.timestamp) + t.reviewWindowSeconds;
        emit ResultSubmitted(id, msg.sender, attempt, hash, uri, t.submittedAt, t.reviewDeadline);
    }

    function acceptResult(uint256 id, uint64 attempt, bytes32 hash) external nonReentrant {
        TaskTypes.Task storage t = _review(id, attempt, hash);
        _settle(id, t, TaskTypes.SettlementReason.REQUESTER_ACCEPT);
    }

    function rejectResult(uint256 id, uint64 attempt, bytes32 hash, bytes32 reason) external nonReentrant {
        TaskTypes.Task storage t = _review(id, attempt, hash);
        if (reason == 0) revert InvalidParameters();
        emit ResultRejected(id, t.worker, attempt, hash, reason);
        _reopenOrExpire(id, t);
    }

    function finalize(uint256 id) external nonReentrant {
        TaskTypes.Task storage t = _task(id); _state(t, TaskTypes.Status.SUBMITTED);
        if (block.timestamp < t.reviewDeadline) revert DeadlineNotReached();
        _settle(id, t, TaskTypes.SettlementReason.REVIEW_TIMEOUT);
    }

    function settleWithVerdicts(uint256 id, uint64 attempt, bytes32 hash, uint16[] calldata bps, bytes[] calldata sigs)
        external nonReentrant
    {
        TaskTypes.Task storage t = _task(id); _state(t, TaskTypes.Status.SUBMITTED);
        _attempt(t, attempt);
        if (hash != t.resultHash) revert ResultHashMismatch();
        uint16 median = _verdictMedian(id, attempt, hash, bps, sigs);
        uint128 workerAmount = uint128(uint256(t.rewardAmount) * median / 10000);
        uint128 refundAmount = t.rewardAmount - workerAmount;
        t.status = TaskTypes.Status.SETTLED; totalEscrowed -= t.rewardAmount;
        IERC20 token = IERC20(settlementToken);
        if (workerAmount > 0) token.safeTransfer(t.worker, workerAmount);
        if (refundAmount > 0) token.safeTransfer(t.requester, refundAmount);
        emit VerdictSettled(id, t.worker, median, workerAmount, refundAmount);
        emit TaskSettled(id, t.requester, t.worker, attempt, hash, workerAmount, TaskTypes.SettlementReason.JUDGE_VERDICT);
    }

    function _verdictMedian(uint256 id, uint64 attempt, bytes32 hash, uint16[] calldata bps, bytes[] calldata sigs)
        private view returns (uint16)
    {
        if (bps.length < judgeThreshold || bps.length != sigs.length) revert InvalidVerdictCount();
        address[] memory seen = new address[](bps.length);
        uint16[] memory votes = new uint16[](bps.length);
        for (uint256 i = 0; i < bps.length; i++) {
            if (bps[i] > 10000) revert InvalidParameters();
            address signer = ECDSA.recover(
                keccak256(abi.encodePacked(
                    "\x19\x01", _verdictDomain, keccak256(abi.encode(VERDICT_TYPEHASH, id, attempt, hash, bps[i]))
                )),
                sigs[i]
            );
            if (!isJudge[signer]) revert UnknownJudge(signer);
            for (uint256 j = 0; j < i; j++) if (seen[j] == signer) revert DuplicateJudge();
            seen[i] = signer; votes[i] = bps[i];
        }
        // Insertion sort (N is bounded by judge count); even counts take the LOWER middle.
        for (uint256 i = 1; i < votes.length; i++) {
            uint16 v = votes[i]; uint256 j = i;
            while (j > 0 && votes[j - 1] > v) { votes[j] = votes[j - 1]; j--; }
            votes[j] = v;
        }
        return votes[(votes.length - 1) / 2];
    }

    function releaseExpiredClaim(uint256 id) external nonReentrant {
        TaskTypes.Task storage t = _task(id); _state(t, TaskTypes.Status.CLAIMED);
        if (block.timestamp < t.claimLeaseExpiresAt) revert DeadlineNotReached();
        emit ClaimReleased(id, t.worker, t.attempt);
        _reopenOrExpire(id, t);
    }

    function expireTask(uint256 id) external nonReentrant {
        TaskTypes.Task storage t = _task(id);
        if (t.status != TaskTypes.Status.OPEN && t.status != TaskTypes.Status.CLAIMED) revert InvalidState(t.status);
        if (block.timestamp < t.taskDeadline) revert DeadlineNotReached();
        _expire(id, t);
    }

    function cancelTask(uint256 id) external nonReentrant {
        TaskTypes.Task storage t = _task(id); _state(t, TaskTypes.Status.OPEN);
        if (msg.sender != t.requester) revert NotRequester();
        if (block.timestamp >= t.taskDeadline) revert DeadlineReached();
        t.status = TaskTypes.Status.CANCELLED;
        _refund(t);
        emit TaskCancelled(id, t.requester, t.rewardAmount);
    }

    function _task(uint256 id) private view returns (TaskTypes.Task storage t) {
        t = tasks[id]; if (t.requester == address(0)) revert TaskNotFound(id);
    }
    function _state(TaskTypes.Task storage t, TaskTypes.Status state) private view {
        if (t.status != state) revert InvalidState(t.status);
    }
    function _attempt(TaskTypes.Task storage t, uint64 attempt) private view {
        if (attempt != t.attempt) revert AttemptMismatch(attempt, t.attempt);
    }
    function _review(uint256 id, uint64 attempt, bytes32 hash) private view returns (TaskTypes.Task storage t) {
        t = _task(id); _state(t, TaskTypes.Status.SUBMITTED);
        if (msg.sender != t.requester) revert NotRequester();
        _attempt(t, attempt);
        if (hash != t.resultHash) revert ResultHashMismatch();
        if (block.timestamp >= t.reviewDeadline) revert DeadlineReached();
    }
    function _settle(uint256 id, TaskTypes.Task storage t, TaskTypes.SettlementReason reason) private {
        t.status = TaskTypes.Status.SETTLED; totalEscrowed -= t.rewardAmount;
        IERC20(settlementToken).safeTransfer(t.worker, t.rewardAmount);
        emit TaskSettled(id, t.requester, t.worker, t.attempt, t.resultHash, t.rewardAmount, reason);
    }
    function _refund(TaskTypes.Task storage t) private {
        totalEscrowed -= t.rewardAmount;
        IERC20(settlementToken).safeTransfer(t.requester, t.rewardAmount);
    }
    function _expire(uint256 id, TaskTypes.Task storage t) private {
        t.status = TaskTypes.Status.EXPIRED; _refund(t);
        emit TaskExpired(id, t.requester, t.rewardAmount);
    }
    function _reopenOrExpire(uint256 id, TaskTypes.Task storage t) private {
        t.worker = address(0); t.resultHash = 0; delete t.resultURI;
        t.claimLeaseExpiresAt = 0; t.submittedAt = 0; t.reviewDeadline = 0;
        if (block.timestamp >= t.taskDeadline) _expire(id, t);
        else { t.status = TaskTypes.Status.OPEN; emit TaskReopened(id, t.attempt); }
    }
}
