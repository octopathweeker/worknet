// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {TaskManager} from "../src/TaskManager.sol";
import {RequesterVault} from "../src/RequesterVault.sol";
import {ITaskManager} from "../src/interfaces/ITaskManager.sol";
import {IRequesterVault} from "../src/interfaces/IRequesterVault.sol";
import {TaskTypes} from "../src/libraries/TaskTypes.sol";
import {MockUSDC} from "./MockUSDC.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
}

contract TaskNetworkTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    MockUSDC token; TaskManager manager; RequesterVault vault;
    address constant AGENT = address(0xA1);
    address constant WORKER = address(0xB1);
    address constant OTHER = address(0xB2);
    bytes32 constant RESULT = keccak256("result");
    uint256 nonce;

    function setUp() public {
        vm.warp(10000);
        token = new MockUSDC(); manager = new TaskManager(address(token));
        vault = new RequesterVault(address(this), address(manager), address(token));
        token.mint(address(this), 100_000_000);
        token.approve(address(manager), type(uint256).max);
        token.approve(address(vault), type(uint256).max); vault.deposit(50_000_000);
        _authorize();
    }
    function _authorize() internal { vault.authorizeAgent(AGENT, TaskTypes.AuthorizationParams(uint64(block.timestamp), uint64(block.timestamp + 10000), 2_000_000, 10_000_000)); }
    function _params() internal view returns (TaskTypes.CreateTaskParams memory) {
        return TaskTypes.CreateTaskParams(keccak256("cap"), keccak256("spec"), "https://example.test/spec", 1_000_000, uint64(block.timestamp + 1000), 180, 300);
    }
    function _create() internal returns (uint256) { return manager.createTask(bytes32(++nonce), AGENT, _params()); }
    function _vaultCreate() internal returns (uint256) { vm.prank(AGENT); return vault.createTask(bytes32(++nonce), _params()); }
    function _submit(uint256 id) internal { vm.startPrank(WORKER); uint64 a = manager.claimTask(id); manager.submitResult(id, a, RESULT, "https://example.test/result"); vm.stopPrank(); }
    function _status(uint256 id, TaskTypes.Status status) internal view { require(manager.getTask(id).status == status, "status"); }

    function testHappyPathThroughVault() public {
        uint256 id = _vaultCreate(); require(token.balanceOf(address(manager)) == 1_000_000);
        _submit(id); vm.prank(AGENT); vault.acceptResult(id, 1, RESULT);
        _status(id, TaskTypes.Status.SETTLED); require(token.balanceOf(WORKER) == 1_000_000);
        require(manager.totalEscrowed() == 0); require(vault.getAuthorization(AGENT).committed == 1_000_000);
    }
    function testUnknownTaskDoesNotLookOpen() public { vm.expectRevert(abi.encodeWithSelector(ITaskManager.TaskNotFound.selector, 9)); manager.getTask(9); }
    function testIdempotentAfterDeadlineAndTerminal() public {
        TaskTypes.CreateTaskParams memory p = _params(); uint256 id = manager.createTask(bytes32(uint256(9)), AGENT, p);
        manager.cancelTask(id); vm.warp(p.taskDeadline + 1);
        require(manager.createTask(bytes32(uint256(9)), AGENT, p) == id);
        require(manager.nextTaskId() == 2 && manager.totalEscrowed() == 0);
        p.rewardAmount++;
        vm.expectRevert(abi.encodeWithSelector(ITaskManager.RequestIdConflict.selector, bytes32(uint256(9))));
        manager.createTask(bytes32(uint256(9)), AGENT, p);
    }
    function testVaultIdempotencyDoesNotConsumeCommitmentTwice() public {
        TaskTypes.CreateTaskParams memory p = _params(); vm.startPrank(AGENT);
        uint256 id = vault.createTask(bytes32(uint256(9)), p);
        require(vault.createTask(bytes32(uint256(9)), p) == id);
        vm.stopPrank(); require(vault.getAuthorization(AGENT).committed == p.rewardAmount);
        require(token.allowance(address(vault), address(manager)) == 0);
    }
    function testNoWorkerExpiryRefundsVaultButDoesNotRestoreBudget() public {
        uint256 id = _vaultCreate(); vm.warp(manager.getTask(id).taskDeadline); manager.expireTask(id);
        _status(id, TaskTypes.Status.EXPIRED); require(token.balanceOf(address(vault)) == 50_000_000);
        require(vault.getAuthorization(AGENT).committed == 1_000_000);
    }
    function testLeaseBoundaryReleaseAndNewWorker() public {
        uint256 id = _create(); vm.prank(WORKER); manager.claimTask(id);
        uint64 lease = manager.getTask(id).claimLeaseExpiresAt;
        vm.warp(lease - 1); vm.expectRevert(ITaskManager.DeadlineNotReached.selector); manager.releaseExpiredClaim(id);
        vm.warp(lease); vm.prank(WORKER); vm.expectRevert(ITaskManager.DeadlineReached.selector); manager.submitResult(id, 1, RESULT, "r");
        manager.releaseExpiredClaim(id); vm.prank(OTHER); require(manager.claimTask(id) == 2);
        vm.prank(WORKER); vm.expectRevert(ITaskManager.NotAssignedWorker.selector); manager.submitResult(id, 1, RESULT, "r");
    }
    function testRejectReopensAndOldAttemptCannotAcceptNewResult() public {
        uint256 id = _create(); _submit(id); manager.rejectResult(id, 1, RESULT, keccak256("reason"));
        _status(id, TaskTypes.Status.OPEN); require(manager.totalEscrowed() == 1_000_000);
        _submit(id);
        vm.expectRevert(abi.encodeWithSelector(ITaskManager.AttemptMismatch.selector, uint64(1), uint64(2))); manager.acceptResult(id, 1, RESULT);
        vm.expectRevert(ITaskManager.ResultHashMismatch.selector); manager.acceptResult(id, 2, keccak256("old"));
        manager.acceptResult(id, 2, RESULT);
    }
    function testLateSubmissionGetsFullReviewAndRejectRefunds() public {
        uint256 id = _create(); uint64 deadline = manager.getTask(id).taskDeadline;
        vm.warp(deadline - 1); _submit(id); require(manager.getTask(id).reviewDeadline == deadline - 1 + 300);
        vm.warp(deadline); vm.expectRevert(); manager.expireTask(id);
        manager.rejectResult(id, 1, RESULT, keccak256("invalid")); _status(id, TaskTypes.Status.EXPIRED);
        require(token.balanceOf(address(this)) == 50_000_000);
    }
    function testReviewDeadlineExactlyPermissionlessFinalizesOnce() public {
        uint256 id = _create(); _submit(id); uint64 deadline = manager.getTask(id).reviewDeadline;
        vm.warp(deadline - 1); vm.expectRevert(ITaskManager.DeadlineNotReached.selector); manager.finalize(id);
        vm.warp(deadline); vm.expectRevert(ITaskManager.DeadlineReached.selector); manager.acceptResult(id, 1, RESULT);
        vm.expectRevert(ITaskManager.DeadlineReached.selector); manager.rejectResult(id, 1, RESULT, keccak256("r"));
        vm.prank(OTHER); manager.finalize(id); require(token.balanceOf(WORKER) == 1_000_000);
        vm.expectRevert(); manager.finalize(id); vm.expectRevert(); manager.expireTask(id); vm.expectRevert(); manager.cancelTask(id);
    }
    function testClaimRaceAndCancelProtection() public {
        uint256 id = _create(); vm.prank(WORKER); manager.claimTask(id);
        vm.prank(OTHER); vm.expectRevert(); manager.claimTask(id);
        vm.expectRevert(); manager.cancelTask(id);
        vm.warp(manager.getTask(id).taskDeadline); manager.expireTask(id); _status(id, TaskTypes.Status.EXPIRED);
    }
    function testOperatorMetadataDoesNotGrantManagerAuthority() public {
        uint256 id = _create(); _submit(id);
        vm.prank(AGENT); vm.expectRevert(ITaskManager.NotRequester.selector); manager.acceptResult(id, 1, RESULT);
    }
    function testRevokeAndReauthorizeCannotResurrectOldTask() public {
        uint256 id = _vaultCreate(); _submit(id); vault.revokeAgent(AGENT);
        vm.prank(AGENT); vm.expectRevert(IRequesterVault.UnauthorizedAgent.selector); vault.acceptResult(id, 1, RESULT);
        _authorize(); vm.prank(AGENT); vm.expectRevert(IRequesterVault.InvalidTaskAuthority.selector); vault.acceptResult(id, 1, RESULT);
        vault.acceptResult(id, 1, RESULT); _status(id, TaskTypes.Status.SETTLED);
    }
    function testPauseBlocksAgentButOwnerCanTakeover() public {
        uint256 id = _vaultCreate(); _submit(id); vault.setPaused(true);
        vm.prank(AGENT); vm.expectRevert(IRequesterVault.VaultPaused.selector); vault.acceptResult(id, 1, RESULT);
        vault.acceptResult(id, 1, RESULT);
        vm.prank(OTHER); vm.expectRevert(IRequesterVault.NotOwner.selector); vault.withdraw(1, OTHER);
    }
    function testLimitsAndSessionLifetime() public {
        TaskTypes.CreateTaskParams memory p = _params(); p.rewardAmount = 2_000_001;
        vm.prank(AGENT); vm.expectRevert(IRequesterVault.RewardExceedsLimit.selector); vault.createTask(bytes32(uint256(1)), p);
        p.rewardAmount = 2_000_000;
        for (uint256 i = 1; i <= 5; i++) { vm.prank(AGENT); vault.createTask(bytes32(i), p); }
        vm.prank(AGENT); vm.expectRevert(IRequesterVault.SessionBudgetExceeded.selector); vault.createTask(bytes32(uint256(6)), p);
        _authorize(); p.taskDeadline = uint64(block.timestamp + 9700);
        vm.prank(AGENT); vm.expectRevert(IRequesterVault.SessionTooShort.selector); vault.createTask(bytes32(uint256(7)), p);
    }
    function testTransferFailureRollsBackAndCanRetry() public {
        uint256 id = _vaultCreate(); _submit(id); token.setFailure(true);
        vm.prank(AGENT); vm.expectRevert(); vault.acceptResult(id, 1, RESULT);
        _status(id, TaskTypes.Status.SUBMITTED); require(manager.totalEscrowed() == 1_000_000);
        token.setFailure(false); vm.prank(AGENT); vault.acceptResult(id, 1, RESULT);
    }
    function testCreateFailureRollsBackIdAndCommitment() public {
        token.setFailure(true); vm.prank(AGENT); vm.expectRevert(); vault.createTask(bytes32(uint256(1)), _params());
        require(manager.nextTaskId() == 1 && vault.getAuthorization(AGENT).committed == 0);
        token.setFailure(false); require(_vaultCreate() == 1);
    }
    function testRejectsFeeOnTransferToken() public {
        token.setTax(true); vm.expectRevert(ITaskManager.IncorrectTokenAmount.selector); manager.createTask(bytes32(uint256(1)), AGENT, _params());
        require(manager.nextTaskId() == 1 && manager.totalEscrowed() == 0);
    }
    function testReentrantTokenCannotCreateNestedObligations() public {
        token.setCallback(address(manager), abi.encodeCall(manager.createTask, (bytes32(uint256(100)), OTHER, _params())));
        _create(); require(!token.callbackSucceeded()); require(manager.nextTaskId() == 2);
        token.setCallback(address(manager), abi.encodeCall(manager.cancelTask, (uint256(1))));
        manager.cancelTask(1); require(!token.callbackSucceeded()); require(manager.totalEscrowed() == 0);
    }
    function testFuzzRewardConservation(uint128 reward) public {
        reward = uint128(uint256(reward) % 10_000_000 + 1);
        TaskTypes.CreateTaskParams memory p = _params(); p.rewardAmount = reward;
        uint256 id = manager.createTask(bytes32(uint256(1)), AGENT, p); _submit(id); manager.acceptResult(id, 1, RESULT);
        require(token.balanceOf(WORKER) == reward && manager.totalEscrowed() == 0 && token.balanceOf(address(manager)) == 0);
    }
}

contract LifecycleHandler {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    TaskManager public manager; MockUSDC public token; uint256 public count;
    address public constant WORKER = address(0xABC);
    bytes32 constant RESULT = keccak256("r");
    constructor(TaskManager m, MockUSDC t) { manager = m; token = t; t.mint(address(this), 10**24); t.approve(address(m), type(uint256).max); }
    function step(uint8 action, uint16 jump, uint256 seed) external {
        action %= 10;
        if (action == 0 && count < 128) {
            TaskTypes.CreateTaskParams memory p = TaskTypes.CreateTaskParams(bytes32(uint256(1)), bytes32(uint256(2)), "s", uint128(seed % 100000 + 1), uint64(block.timestamp + 1000), 120, 60);
            manager.createTask(bytes32(++count), address(this), p); return;
        }
        if (action == 9) { vm.warp(block.timestamp + jump % 500); return; }
        if (count == 0) return;
        uint256 id = seed % count + 1; TaskTypes.Task memory t = manager.getTask(id);
        if (action == 1) { vm.prank(WORKER); try manager.claimTask(id) {} catch {} }
        if (action == 2) { vm.prank(WORKER); try manager.submitResult(id, t.attempt, RESULT, "r") {} catch {} }
        if (action == 3) { try manager.acceptResult(id, t.attempt, RESULT) {} catch {} }
        if (action == 4) { try manager.rejectResult(id, t.attempt, RESULT, keccak256("bad")) {} catch {} }
        if (action == 5) { try manager.finalize(id) {} catch {} }
        if (action == 6) { try manager.expireTask(id) {} catch {} }
        if (action == 7) { try manager.cancelTask(id) {} catch {} }
        if (action == 8) { try manager.releaseExpiredClaim(id) {} catch {} }
    }
}

contract TaskNetworkInvariantTest {
    TaskManager manager; MockUSDC token; LifecycleHandler handler;
    function setUp() public { token = new MockUSDC(); manager = new TaskManager(address(token)); handler = new LifecycleHandler(manager, token); }
    function targetContracts() external view returns (address[] memory values) { values = new address[](1); values[0] = address(handler); }
    function invariantEscrowAndPaymentsConserved() public view {
        uint256 escrow; uint256 paid; uint256 count = handler.count();
        for (uint256 id = 1; id <= count; id++) {
            TaskTypes.Task memory t = manager.getTask(id);
            if (uint8(t.status) <= 2) escrow += t.rewardAmount;
            if (t.status == TaskTypes.Status.SETTLED) paid += t.rewardAmount;
        }
        require(manager.totalEscrowed() == escrow && token.balanceOf(address(manager)) == escrow, "escrow mismatch");
        require(token.balanceOf(handler.WORKER()) == paid, "double or missing payment");
        require(token.balanceOf(address(handler)) + paid + escrow == 10**24, "funds lost");
    }
}
