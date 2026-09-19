// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice LOCAL DEMO ONLY. Public minting; never label this token Circle USDC.
contract MockUSDC is ERC20 {
    bool public failTransfers;
    bool public taxTransfers;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;
    bool private insideCallback;
    constructor() ERC20("Demo USDC (not Circle)", "dUSDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setFailure(bool value) external { failTransfers = value; }
    function setTax(bool value) external { taxTransfers = value; }
    function setCallback(address target, bytes calldata data) external { callbackTarget = target; callbackData = data; }
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) {
            require(!failTransfers, "test transfer failure");
            if (callbackTarget != address(0) && !insideCallback) {
                insideCallback = true;
                (callbackSucceeded,) = callbackTarget.call(callbackData);
                insideCallback = false;
            }
            if (taxTransfers && amount > 0) { super._update(from, address(0), 1); --amount; }
        }
        super._update(from, to, amount);
    }
}
