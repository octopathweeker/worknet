// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {TaskTypes} from "./TaskTypes.sol";

/// @notice Pure protocol primitives. State/access/token enforcement belongs to M1.
library TaskRules {
    function hashCreateParams(address operator, TaskTypes.CreateTaskParams memory params)
        internal pure returns (bytes32)
    {
        return keccak256(abi.encode(operator, params));
    }

    function capabilityId(string memory capability, string memory version)
        internal pure returns (bytes32)
    {
        return keccak256(abi.encode(capability, version));
    }

    function leaseExpiry(uint64 now_, uint32 leaseSeconds, uint64 taskDeadline)
        internal pure returns (uint64)
    {
        uint256 candidate = uint256(now_) + leaseSeconds;
        return candidate < taskDeadline ? uint64(candidate) : taskDeadline;
    }

    function canSubmit(uint64 now_, uint64 leaseExpiresAt, uint64 taskDeadline)
        internal pure returns (bool)
    {
        return now_ < leaseExpiresAt && now_ < taskDeadline;
    }

    function canReview(uint64 now_, uint64 reviewDeadline) internal pure returns (bool) {
        return now_ < reviewDeadline;
    }

    function afterReleaseOrReject(uint64 now_, uint64 taskDeadline)
        internal pure returns (TaskTypes.Status)
    {
        return now_ < taskDeadline ? TaskTypes.Status.OPEN : TaskTypes.Status.EXPIRED;
    }
}
