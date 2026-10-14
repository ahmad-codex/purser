// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev A merchant contract an agent is allowed to buy from.
contract Shop {
    event Bought(address indexed buyer, uint256 itemId, uint256 paid);

    mapping(address buyer => uint256 count) public purchases;

    function buy(uint256 itemId) external payable {
        purchases[msg.sender] += 1;
        emit Bought(msg.sender, itemId, msg.value);
    }

    function refundAll() external {
        payable(msg.sender).transfer(address(this).balance);
    }
}
