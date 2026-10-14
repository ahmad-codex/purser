// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {PurserAccount} from "../../src/PurserAccount.sol";
import {IPurserAccount} from "../../src/interfaces/IPurserAccount.sol";
import {PurserTestBase} from "../utils/PurserTestBase.sol";

/// @dev The fuzzer drives an agent, a clock and an owner who sometimes revokes or approves.
contract PurserHandler is CommonBase, StdCheats, StdUtils {
    PurserInvariantTest internal immutable t;
    PurserAccount internal immutable account;
    address internal immutable merchant;

    // Ghost state.
    uint48 public windowStart;
    uint256 public unapprovedInWindow;
    uint256 public paidAfterRevoke;
    bool public revoked;
    uint256 public calls;

    constructor(PurserInvariantTest test_, PurserAccount account_, address merchant_) {
        t = test_;
        account = account_;
        merchant = merchant_;
    }

    function agentPays(uint256 amount) external {
        amount = bound(amount, 1, 0.8 ether);
        uint256 before = merchant.balance;
        bool ok = t.trySubmitAgent(amount, false);
        ++calls;
        if (!ok) return;
        uint256 received = merchant.balance - before;
        if (revoked) paidAfterRevoke += received;
        (IPurserAccount.Budget memory b,,) = account.getBudget(t.agentAddress(), address(0));
        if (b.periodStart != windowStart) {
            windowStart = b.periodStart;
            unapprovedInWindow = 0;
        }
        unapprovedInWindow += received;
    }

    function ownerApprovesLargePayment(uint256 amount) external {
        amount = bound(amount, 1, 2 ether);
        uint256 before = merchant.balance;
        bool ok = t.trySubmitAgent(amount, true);
        ++calls;
        if (ok && revoked) paidAfterRevoke += merchant.balance - before;
    }

    function timePasses(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
    }

    function ownerRevokes() external {
        if (revoked) return;
        address key = t.agentAddress();
        address owner = account.owner();
        vm.prank(owner);
        account.revokeSession(key);
        revoked = true;
    }
}

contract PurserInvariantTest is PurserTestBase {
    PurserHandler internal handler;

    function setUp() public override {
        super.setUp();
        vm.deal(address(account), 1_000_000 ether);
        handler = new PurserHandler(this, account, merchant);
        targetContract(address(handler));
    }

    function agentAddress() external view returns (address) {
        return agent;
    }

    /// @dev Called by the handler. Returns whether the payment executed.
    function trySubmitAgent(uint256 amount, bool approved) external returns (bool) {
        PackedUserOperation memory op = buildOp(address(account), payEth(merchant, amount));
        op.signature = approved ? approvedSig(op, agentKey) : sessionSig(op, agentKey);
        try this.submitExternal(op) returns (bool success) {
            return success;
        } catch {
            return false;
        }
    }

    function submitExternal(PackedUserOperation memory op) external returns (bool) {
        return submitAndGetSuccess(op);
    }

    /// @notice Without the owner's approval, an agent never moves more than its budget per window.
    function invariant_unapprovedSpendingStaysWithinBudget() public view {
        assertLe(handler.unapprovedInWindow(), ETH_PER_DAY);
        (IPurserAccount.Budget memory b,,) = account.getBudget(agent, address(0));
        assertLe(b.spent, b.perPeriod);
    }

    /// @notice A revoked key never moves funds again, approved or not.
    function invariant_revokedKeyNeverPays() public view {
        assertEq(handler.paidAfterRevoke(), 0);
    }

    /// @notice The stored policy never changes behind the owner's back.
    function invariant_policyIsUnchanged() public view {
        assertTrue(account.isAllowed(agent, merchant, bytes4(0)));
        (IPurserAccount.Budget memory b,,) = account.getBudget(agent, address(0));
        assertEq(b.perTx, ETH_PER_TX);
        assertEq(b.perPeriod, ETH_PER_DAY);
        assertEq(account.owner(), owner);
    }
}
