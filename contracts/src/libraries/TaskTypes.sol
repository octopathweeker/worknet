// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

library TaskTypes {
    // A zeroed mapping slot is NOT an existing OPEN task: check requester != address(0).
    enum Status { OPEN, CLAIMED, SUBMITTED, SETTLED, CANCELLED, EXPIRED }
    enum SettlementReason { REQUESTER_ACCEPT, REVIEW_TIMEOUT, JUDGE_VERDICT }

    uint64 internal constant MAX_TASK_LIFETIME = 1 days;
    uint32 internal constant MIN_REVIEW_WINDOW = 60;
    uint32 internal constant MAX_REVIEW_WINDOW = 30 minutes;
    uint256 internal constant MAX_URI_BYTES = 512;

    struct CreateTaskParams {
        bytes32 capabilityId;
        bytes32 specHash;
        string specURI;
        uint128 rewardAmount;
        uint64 taskDeadline;
        uint32 claimLeaseSeconds;
        uint32 reviewWindowSeconds;
    }

    struct Task {
        address requester;
        address operator;
        address worker;
        uint128 rewardAmount;
        bytes32 capabilityId;
        bytes32 specHash;
        string specURI;
        uint64 taskDeadline;
        uint32 claimLeaseSeconds;
        uint32 reviewWindowSeconds;
        uint64 attempt;
        uint64 claimLeaseExpiresAt;
        uint64 submittedAt;
        uint64 reviewDeadline;
        bytes32 resultHash;
        string resultURI;
        Status status;
    }

    struct AuthorizationParams {
        uint64 validAfter;
        uint64 validUntil;
        uint128 maxPerTask;
        uint128 maxTotalCommitment;
    }

    struct AgentAuthorization {
        bool active;
        uint64 epoch;
        uint64 validAfter;
        uint64 validUntil;
        uint128 maxPerTask;
        uint128 maxTotalCommitment;
        uint128 committed;
    }

    struct TaskAuthority { address operator; uint64 epoch; }
}
