// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {PurserTestBase} from "./utils/PurserTestBase.sol";

/// @dev Random sequences of agent payments and time jumps, checked against a simple model of the
///      budget: a fixed window that starts at the first spend and lasts one period.
contract PurserFuzzTest is PurserTestBase {
    function testFuzz_paymentsFollowTheBudgetModel(uint96[12] memory amounts, uint32[12] memory gaps) public {
        uint256 windowStart;
        uint256 windowSpent;
        uint256 paid;

        for (uint256 i; i < amounts.length; ++i) {
            vm.warp(block.timestamp + (gaps[i] % (2 * DAY)));
            uint256 amount = bound(amounts[i], 1, ETH_PER_TX);

            if (windowStart == 0 || block.timestamp >= windowStart + DAY) {
                windowStart = block.timestamp;
                windowSpent = 0;
            }
            bool shouldPass = windowSpent + amount <= ETH_PER_DAY;

            bool passed = submitAndGetSuccess(agentOp(payEth(merchant, amount)));
            assertEq(passed, shouldPass, "outcome matches the budget model");
            if (passed) {
                windowSpent += amount;
                paid += amount;
            }
            assertLe(windowSpent, ETH_PER_DAY);
        }
        assertEq(merchant.balance, paid);
    }

    function testFuzz_overTransactionCapNeverPasses(uint128 amount) public {
        amount = uint128(bound(amount, uint256(ETH_PER_TX) + 1, 9 ether));
        (bool ok,) = account.previewCalls(agent, payEth(merchant, amount));
        assertFalse(ok);
        PackedUserOperation memory op = agentOp(payEth(merchant, amount));
        vm.expectRevert();
        submit(op);
        assertEq(merchant.balance, 0);
    }

    function testFuzz_tokenBudget(uint96 first, uint96 second) public {
        uint256 a = bound(first, 1, TOKEN_PER_TX);
        uint256 b = bound(second, 1, TOKEN_PER_TX);
        assertTrue(submitAndGetSuccess(agentOp(payToken(merchant, a))));
        bool passed = submitAndGetSuccess(agentOp(payToken(merchant, b)));
        assertEq(passed, a + b <= TOKEN_PER_DAY);
        assertEq(token.balanceOf(merchant), passed ? a + b : a);
    }
}
