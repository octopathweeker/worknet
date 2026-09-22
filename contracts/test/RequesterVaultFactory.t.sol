// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
import {RequesterVaultFactory} from "../src/RequesterVaultFactory.sol";
import {RequesterVault} from "../src/RequesterVault.sol";
import {TaskManager} from "../src/TaskManager.sol";
import {MockUSDC} from "./MockUSDC.sol";

interface FactoryVm { function prank(address) external; function expectRevert() external; }
contract RequesterVaultFactoryTest {
    FactoryVm constant vm = FactoryVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    function testPredictionIsolationAndPermissionlessIdempotence() external {
        MockUSDC token = new MockUSDC();
        address[] memory judges = new address[](1); judges[0] = address(0x1234);
        TaskManager manager = new TaskManager(address(token), judges, 1);
        RequesterVaultFactory factory = new RequesterVaultFactory(address(manager), address(token));
        address alice = address(0xA11CE); address bob = address(0xB0B);
        address expected = factory.predictVault(alice);
        vm.prank(bob); address a = factory.createVault(alice);
        require(a == expected && RequesterVault(a).owner() == alice, "prediction/owner");
        require(factory.createVault(alice) == a, "idempotence");
        address b = factory.createVault(bob); require(a != b, "isolation");
        token.mint(a, 100); token.mint(b, 200);
        vm.prank(bob); vm.expectRevert(); RequesterVault(a).withdraw(100, bob);
        require(token.balanceOf(a) == 100 && token.balanceOf(b) == 200, "fund isolation");
        vm.expectRevert(); factory.createVault(address(0));
    }
}
