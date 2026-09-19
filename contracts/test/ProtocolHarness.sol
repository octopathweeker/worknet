// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {TaskTypes} from "../src/libraries/TaskTypes.sol";
import {TaskRules} from "../src/libraries/TaskRules.sol";

/// @notice Test-only pure harness, never a deployable TaskManager.
contract ProtocolHarness {
    function hashCreateParams(address operator, TaskTypes.CreateTaskParams memory params) external pure returns (bytes32) {
        return TaskRules.hashCreateParams(operator, params);
    }
    function capabilityId(string memory capability, string memory version) external pure returns (bytes32) {
        return TaskRules.capabilityId(capability, version);
    }
    function hashBytes(bytes memory value) external pure returns (bytes32) { return keccak256(value); }
    function leaseExpiry(uint64 now_, uint32 leaseSeconds, uint64 deadline) external pure returns (uint64) {
        return TaskRules.leaseExpiry(now_, leaseSeconds, deadline);
    }
    function canSubmit(uint64 now_, uint64 lease, uint64 deadline) external pure returns (bool) {
        return TaskRules.canSubmit(now_, lease, deadline);
    }
    function canReview(uint64 now_, uint64 deadline) external pure returns (bool) {
        return TaskRules.canReview(now_, deadline);
    }
    function afterReleaseOrReject(uint64 now_, uint64 deadline) external pure returns (TaskTypes.Status) {
        return TaskRules.afterReleaseOrReject(now_, deadline);
    }
}
