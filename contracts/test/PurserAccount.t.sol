// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {PurserAccount} from "../src/PurserAccount.sol";
import {IPurserAccount} from "../src/interfaces/IPurserAccount.sol";
import {PurserTestBase} from "./utils/PurserTestBase.sol";
import {MockToken, Shop} from "./utils/Mocks.sol";

contract PurserAccountTest is PurserTestBase {
    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    function test_ownerCanCallAnything() public {
        PackedUserOperation memory op = buildOp(address(account), payEth(makeAddr("anyone"), 5 ether));
        op.signature = ownerSig(op);
        assertTrue(submitAndGetSuccess(op));
        assertEq(makeAddr("anyone").balance, 5 ether);
    }

    function test_ownerCanManageSessionsThroughUserOp() public {
        PackedUserOperation memory op = buildOp(
            address(account), one(address(account), 0, abi.encodeCall(PurserAccount.revokeSession, (agent)))
        );
        op.signature = ownerSig(op);
        assertTrue(submitAndGetSuccess(op));
        assertFalse(account.getSession(agent).active);
    }

    function test_ownerCanActWithoutBundler() public {
        vm.prank(owner);
        account.executeByOwner(payEth(merchant, 2 ether));
        assertEq(merchant.balance, 2 ether);
    }

    function test_strangerCannotAdminister() public {
        vm.expectRevert(IPurserAccount.NotOwner.selector);
        account.setFrozen(true);
        vm.expectRevert(IPurserAccount.NotOwner.selector);
        account.executeByOwner(payEth(merchant, 1 ether));
    }

    function test_wrongOwnerSignatureIsRejected() public {
        PackedUserOperation memory op = buildOp(address(account), payEth(merchant, 1 ether));
        op.signature = abi.encodePacked(uint8(0), sign(agentKey, entryPoint.getUserOpHash(op)));
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        submit(op);
    }

    function test_transferOwnership() public {
        address next = makeAddr("next owner");
        vm.prank(owner);
        account.transferOwnership(next);
        assertEq(account.owner(), next);
    }

    // ---------------------------------------------------------------------------------------------
    // Factory
    // ---------------------------------------------------------------------------------------------

    function test_factoryAddressIsDeterministic() public {
        address predicted = factory.getAddress(owner, 7);
        assertEq(predicted.code.length, 0);
        PurserAccount created = factory.createAccount(owner, 7);
        assertEq(address(created), predicted);
        assertEq(address(factory.createAccount(owner, 7)), predicted, "second call returns the same account");
        assertEq(created.owner(), owner);
    }

    function test_accountIsDeployedByFirstUserOp() public {
        address predicted = factory.getAddress(owner, 99);
        vm.deal(predicted, 1 ether);
        PackedUserOperation memory op = buildOp(predicted, payEth(merchant, 0.1 ether));
        op.initCode = abi.encodePacked(address(factory), abi.encodeCall(factory.createAccount, (owner, 99)));
        op.signature = ownerSig(op);
        assertTrue(submitAndGetSuccess(op));
        assertGt(predicted.code.length, 0);
        assertEq(merchant.balance, 0.1 ether);
    }

    function test_implementationCannotBeInitialized() public {
        PurserAccount impl = factory.accountImplementation();
        vm.expectRevert();
        impl.initialize(address(this));
    }

    // ---------------------------------------------------------------------------------------------
    // Session keys within budget
    // ---------------------------------------------------------------------------------------------

    function test_agentPaysWithinBudget() public {
        assertTrue(submitAndGetSuccess(agentOp(payEth(merchant, 0.3 ether))));
        assertEq(merchant.balance, 0.3 ether);
        assertEq(spent(address(0)), ETH_PER_DAY - 0.3 ether);
    }

    function test_agentBuysFromAllowedContract() public {
        IPurserAccount.Call[] memory calls = one(address(shop), 0.2 ether, abi.encodeCall(Shop.buy, (42)));
        assertTrue(submitAndGetSuccess(agentOp(calls)));
        assertEq(shop.purchases(address(account)), 1);
        assertEq(spent(address(0)), ETH_PER_DAY - 0.2 ether);
    }

    function test_agentTransfersTokensWithinBudget() public {
        assertTrue(submitAndGetSuccess(agentOp(payToken(merchant, 80e18))));
        assertEq(token.balanceOf(merchant), 80e18);
        assertEq(spent(address(token)), TOKEN_PER_DAY - 80e18);
    }

    function test_approvalCountsAsSpending() public {
        IPurserAccount.Call[] memory calls =
            one(address(token), 0, abi.encodeCall(IERC20.approve, (merchant, 90e18)));
        assertTrue(submitAndGetSuccess(agentOp(calls)));
        assertEq(spent(address(token)), TOKEN_PER_DAY - 90e18);
    }

    function test_batchIsCheckedAsAWhole() public {
        IPurserAccount.Call[] memory calls = new IPurserAccount.Call[](3);
        calls[0] = IPurserAccount.Call(merchant, 0.4 ether, "");
        calls[1] = IPurserAccount.Call(merchant, 0.4 ether, "");
        calls[2] = IPurserAccount.Call(merchant, 0.4 ether, "");
        assertFalse(
            submitAndGetSuccess(agentOp(calls)), "1.2 ETH in one batch exceeds the 1 ETH daily budget"
        );
        assertEq(merchant.balance, 0);
        assertEq(spent(address(0)), ETH_PER_DAY, "a failed batch spends nothing");
    }

    // ---------------------------------------------------------------------------------------------
    // Session keys outside the policy
    // ---------------------------------------------------------------------------------------------

    function test_overTransactionCapIsRejectedBeforeExecution() public {
        PackedUserOperation memory op = agentOp(payEth(merchant, 0.6 ether));
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA23 reverted",
                abi.encodeWithSelector(
                    IPurserAccount.OverTransactionLimit.selector, address(0), 0.6 ether, ETH_PER_TX
                )
            )
        );
        submit(op);
    }

    function test_overDailyBudgetFailsAndSpendsNothing() public {
        assertTrue(submitAndGetSuccess(agentOp(payEth(merchant, 0.5 ether))));
        assertTrue(submitAndGetSuccess(agentOp(payEth(merchant, 0.4 ether))));
        assertFalse(submitAndGetSuccess(agentOp(payEth(merchant, 0.2 ether))));
        assertEq(merchant.balance, 0.9 ether);
        assertEq(spent(address(0)), 0.1 ether);
    }

    function test_budgetResetsAfterPeriod() public {
        assertTrue(submitAndGetSuccess(agentOp(payEth(merchant, 0.5 ether))));
        assertTrue(submitAndGetSuccess(agentOp(payEth(merchant, 0.5 ether))));
        assertFalse(submitAndGetSuccess(agentOp(payEth(merchant, 0.1 ether))));

        vm.warp(block.timestamp + DAY);
        assertTrue(submitAndGetSuccess(agentOp(payEth(merchant, 0.5 ether))));
        assertEq(merchant.balance, 1.5 ether);
    }

    function test_disallowedTargetIsRejected() public {
        address stranger = makeAddr("stranger");
        PackedUserOperation memory op = agentOp(payEth(stranger, 0.1 ether));
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA23 reverted",
                abi.encodeWithSelector(IPurserAccount.CallNotAllowed.selector, stranger, bytes4(0))
            )
        );
        submit(op);
    }

    function test_disallowedFunctionIsRejected() public {
        PackedUserOperation memory op = agentOp(one(address(shop), 0, abi.encodeCall(Shop.refundAll, ())));
        vm.expectRevert();
        submit(op);
    }

    function test_tokenWithoutBudgetIsRejected() public {
        MockToken other = new MockToken();
        other.mint(address(account), 10e18);
        IPurserAccount.SessionConfig memory config = defaultConfig();
        config.permissions[2] = IPurserAccount.Permission(address(other), IERC20.transfer.selector);
        vm.prank(owner);
        account.addSession(agent, config);

        PackedUserOperation memory op =
            agentOp(one(address(other), 0, abi.encodeCall(IERC20.transfer, (merchant, 1e18))));
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA23 reverted",
                abi.encodeWithSelector(IPurserAccount.TokenNotAllowed.selector, address(other))
            )
        );
        submit(op);
    }

    function test_agentCannotCallTheAccountItself() public {
        IPurserAccount.Call[] memory calls =
            one(address(account), 0, abi.encodeCall(PurserAccount.addSession, (agent, defaultConfig())));
        PackedUserOperation memory op = agentOp(calls);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA23 reverted",
                abi.encodeWithSelector(IPurserAccount.SelfCallNotAllowed.selector)
            )
        );
        submit(op);
    }

    function test_selfPermissionCannotBeGranted() public {
        IPurserAccount.SessionConfig memory config = defaultConfig();
        config.permissions[0] = IPurserAccount.Permission(address(account), bytes4(0xffffffff));
        vm.prank(owner);
        vm.expectRevert(IPurserAccount.InvalidSessionConfig.selector);
        account.addSession(agent, config);
    }

    function test_sessionKeyCannotSignAsOwner() public {
        PackedUserOperation memory op = buildOp(address(account), payEth(merchant, 1 ether));
        op.signature = abi.encodePacked(uint8(0), sign(agentKey, entryPoint.getUserOpHash(op)));
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        submit(op);
    }

    function test_unknownKeyIsRejected() public {
        PackedUserOperation memory op = buildOp(address(account), payEth(merchant, 0.1 ether));
        op.signature = sessionSig(op, 0xBAD);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        submit(op);
    }

    function test_forgedKeyInSignatureIsRejected() public {
        PackedUserOperation memory op = buildOp(address(account), payEth(merchant, 0.1 ether));
        // Claims to be the agent but is signed by another key.
        op.signature = abi.encodePacked(uint8(1), agent, sign(0xBAD, entryPoint.getUserOpHash(op)));
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        submit(op);
    }

    // ---------------------------------------------------------------------------------------------
    // Time window, revocation, freeze
    // ---------------------------------------------------------------------------------------------

    function test_expiredSessionIsRejected() public {
        vm.warp(block.timestamp + 31 days);
        PackedUserOperation memory op = agentOp(payEth(merchant, 0.1 ether));
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA22 expired or not due"));
        submit(op);
    }

    function test_sessionNotYetValidIsRejected() public {
        IPurserAccount.SessionConfig memory config = defaultConfig();
        config.validAfter = uint48(block.timestamp + 1 hours);
        vm.prank(owner);
        account.addSession(agent, config);

        PackedUserOperation memory op = agentOp(payEth(merchant, 0.1 ether));
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA22 expired or not due"));
        submit(op);
    }

    function test_revokedSessionIsRejected() public {
        vm.prank(owner);
        account.revokeSession(agent);
        PackedUserOperation memory op = agentOp(payEth(merchant, 0.1 ether));
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        submit(op);
    }

    function test_regrantingAKeyClearsOldPermissions() public {
        IPurserAccount.SessionConfig memory config = defaultConfig();
        config.permissions = new IPurserAccount.Permission[](1);
        config.permissions[0] = IPurserAccount.Permission(address(shop), Shop.buy.selector);
        vm.prank(owner);
        account.addSession(agent, config);

        assertFalse(account.isAllowed(agent, merchant, bytes4(0)), "old merchant permission is gone");
        assertTrue(account.isAllowed(agent, address(shop), Shop.buy.selector));
        assertEq(account.getSession(agent).epoch, 2);
    }

    function test_revokeInSameBundleStopsLaterAgentOp() public {
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = buildOp(
            address(account), one(address(account), 0, abi.encodeCall(PurserAccount.revokeSession, (agent)))
        );
        ops[0].signature = ownerSig(ops[0]);
        // Same account, same nonce key: the agent op takes the next nonce.
        ops[1] = buildOp(address(account), payEth(merchant, 0.1 ether));
        ops[1].nonce = ops[0].nonce + 1;
        ops[1].signature = sessionSig(ops[1], agentKey);

        entryPoint.handleOps(ops, bundler);
        assertEq(merchant.balance, 0, "validation passed before the revoke, execution must still refuse");
    }

    function test_freezeStopsAgentsButNotOwner() public {
        vm.prank(owner);
        account.setFrozen(true);

        PackedUserOperation memory op = agentOp(payEth(merchant, 0.1 ether));
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA23 reverted",
                abi.encodeWithSelector(IPurserAccount.AccountFrozen.selector)
            )
        );
        submit(op);

        PackedUserOperation memory ownerOp = buildOp(address(account), payEth(merchant, 0.1 ether));
        ownerOp.signature = ownerSig(ownerOp);
        assertTrue(submitAndGetSuccess(ownerOp));

        vm.prank(owner);
        account.setFrozen(false);
        assertTrue(submitAndGetSuccess(agentOp(payEth(merchant, 0.1 ether))));
    }

    // ---------------------------------------------------------------------------------------------
    // Owner approval for over-limit actions
    // ---------------------------------------------------------------------------------------------

    function test_ownerApprovalAllowsOverLimitAction() public {
        PackedUserOperation memory op = buildOp(address(account), payEth(merchant, 3 ether));
        op.signature = approvedSig(op, agentKey);
        assertTrue(submitAndGetSuccess(op));
        assertEq(merchant.balance, 3 ether);
        assertEq(spent(address(0)), ETH_PER_DAY, "approved spending does not use the agent's budget");
    }

    function test_approvalDoesNotWidenTheAllowList() public {
        address stranger = makeAddr("stranger");
        PackedUserOperation memory op = buildOp(address(account), payEth(stranger, 1 ether));
        op.signature = approvedSig(op, agentKey);
        vm.expectRevert();
        submit(op);
    }

    function test_approvalNeedsTheRealOwner() public {
        PackedUserOperation memory op = buildOp(address(account), payEth(merchant, 3 ether));
        bytes32 hash = entryPoint.getUserOpHash(op);
        op.signature = abi.encodePacked(uint8(2), agent, sign(agentKey, hash), sign(0xBAD, hash));
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        submit(op);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function test_previewCalls() public {
        (bool ok,) = account.previewCalls(agent, payEth(merchant, 0.4 ether));
        assertTrue(ok);

        (ok,) = account.previewCalls(agent, payEth(merchant, 0.6 ether));
        assertFalse(ok, "over per-transaction cap");

        assertTrue(submitAndGetSuccess(agentOp(payEth(merchant, 0.5 ether))));
        assertTrue(submitAndGetSuccess(agentOp(payEth(merchant, 0.5 ether))));
        bytes memory reason;
        (ok, reason) = account.previewCalls(agent, payEth(merchant, 0.1 ether));
        assertFalse(ok);
        assertEq(
            reason, abi.encodeWithSelector(IPurserAccount.OverPeriodBudget.selector, address(0), 0.1 ether, 0)
        );
    }

    function test_getBudgetReportsReset() public {
        assertTrue(submitAndGetSuccess(agentOp(payEth(merchant, 0.5 ether))));
        (IPurserAccount.Budget memory b, uint256 remaining, uint256 resetsAt) =
            account.getBudget(agent, address(0));
        assertEq(b.spent, 0.5 ether);
        assertEq(remaining, 0.5 ether);
        assertEq(resetsAt, block.timestamp + DAY);

        vm.warp(block.timestamp + DAY);
        (b, remaining, resetsAt) = account.getBudget(agent, address(0));
        assertEq(b.spent, 0);
        assertEq(remaining, ETH_PER_DAY);
        assertEq(resetsAt, 0);
    }

    function test_listsSessionKeysAndBudgetTokens() public view {
        address[] memory keys = account.sessionKeys();
        assertEq(keys.length, 1);
        assertEq(keys[0], agent);
        address[] memory tokens = account.budgetTokens(agent);
        assertEq(tokens.length, 2);
        assertEq(tokens[0], address(0));
        assertEq(tokens[1], address(token));
    }

    function test_erc1271AcceptsOwnerSignatures() public view {
        bytes32 hash = keccak256("hello");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, hash);
        assertEq(account.isValidSignature(hash, abi.encodePacked(r, s, v)), account.isValidSignature.selector);
        (v, r, s) = vm.sign(agentKey, hash);
        assertEq(account.isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0xffffffff));
    }

    // ---------------------------------------------------------------------------------------------
    // Config validation and upgrades
    // ---------------------------------------------------------------------------------------------

    function test_rejectsInvalidConfigs() public {
        IPurserAccount.SessionConfig memory config = defaultConfig();
        config.period = 0;
        vm.startPrank(owner);
        vm.expectRevert(IPurserAccount.InvalidSessionConfig.selector);
        account.addSession(agent, config);

        config = defaultConfig();
        config.limits[0].perTx = config.limits[0].perPeriod + 1;
        vm.expectRevert(IPurserAccount.InvalidSessionConfig.selector);
        account.addSession(agent, config);

        config = defaultConfig();
        config.validAfter = config.validUntil;
        vm.expectRevert(IPurserAccount.InvalidSessionConfig.selector);
        account.addSession(agent, config);

        vm.expectRevert(IPurserAccount.ZeroAddress.selector);
        account.addSession(owner, defaultConfig());
        vm.stopPrank();
    }

    function test_onlyOwnerCanUpgrade() public {
        PurserAccount next = new PurserAccount(IEntryPoint(address(entryPoint)));
        vm.expectRevert(IPurserAccount.NotOwner.selector);
        account.upgradeToAndCall(address(next), "");

        vm.prank(owner);
        account.upgradeToAndCall(address(next), "");
    }

    function test_executeUserOpOnlyFromEntryPoint() public {
        PackedUserOperation memory op = agentOp(payEth(merchant, 0.1 ether));
        vm.expectRevert(IPurserAccount.NotEntryPoint.selector);
        account.executeUserOp(op, bytes32(0));
    }
}
