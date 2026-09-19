// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {RequesterVault} from "./RequesterVault.sol";

/// @notice One independent budget vault per owner. Creation is permissionless and idempotent.
/// A delegated EOA calls this factory; CREATE executes in the factory's context on Monad.
contract RequesterVaultFactory {
    address public immutable taskManager;
    address public immutable settlementToken;
    mapping(address => address) public vaultOf;
    event VaultCreated(address indexed owner, address indexed vault);

    constructor(address manager, address token) { taskManager = manager; settlementToken = token; }

    function createVault(address owner) external returns (address vault) {
        require(owner != address(0), "ZERO_OWNER");
        vault = vaultOf[owner];
        if (vault != address(0)) return vault;
        vault = address(new RequesterVault{salt: bytes32(uint256(uint160(owner)))}(owner, taskManager, settlementToken));
        vaultOf[owner] = vault;
        emit VaultCreated(owner, vault);
    }

    function predictVault(address owner) external view returns (address) {
        bytes32 initHash = keccak256(abi.encodePacked(type(RequesterVault).creationCode, abi.encode(owner, taskManager, settlementToken)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(uint256(uint160(owner))), initHash)))));
    }
}
