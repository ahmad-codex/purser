// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Demo dollar token. Anyone can mint: it exists only for demos and testnets.
contract DemoToken is ERC20 {
    constructor() ERC20("Purser Demo USD", "dUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice A shop an agent can buy from, paying in ETH.
contract DemoShop {
    event Bought(address indexed buyer, uint256 indexed itemId, uint256 paid);

    function buy(uint256 itemId) external payable {
        emit Bought(msg.sender, itemId, msg.value);
    }
}
