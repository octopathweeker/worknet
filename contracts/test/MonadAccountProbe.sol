// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
contract ProbeChild {}
/// @dev Only for an isolated Testnet EOA: proves CREATE is rejected in delegated context.
contract MonadAccountProbe { function spawn() external returns (address) { return address(new ProbeChild()); } }
