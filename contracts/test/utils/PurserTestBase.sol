// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {PurserAccount} from "../../src/PurserAccount.sol";
import {PurserFactory} from "../../src/PurserFactory.sol";
import {IPurserAccount} from "../../src/interfaces/IPurserAccount.sol";
import {MockToken, Shop} from "./Mocks.sol";

/// @dev Shared setup: a real EntryPoint, a factory, an account with 10 ETH and 1,000 tokens, and an
///      agent session key that may pay a shop and move tokens within a budget.
abstract contract PurserTestBase is Test {
    using MessageHashUtils for bytes32;

    EntryPoint internal entryPoint;
    PurserFactory internal factory;
    PurserAccount internal account;
    MockToken internal token;
    Shop internal shop;

    uint256 internal ownerKey = 0xA11CE;
    uint256 internal agentKey = 0xA6E47;
    address internal owner;
    address internal agent;
    address internal merchant = makeAddr("merchant");
    address payable internal bundler = payable(makeAddr("bundler"));

    uint32 internal constant DAY = 1 days;
    uint128 internal constant ETH_PER_TX = 0.5 ether;
    uint128 internal constant ETH_PER_DAY = 1 ether;
    uint128 internal constant TOKEN_PER_TX = 100e18;
    uint128 internal constant TOKEN_PER_DAY = 250e18;

    function setUp() public virtual {
        vm.warp(1_760_000_000);
        owner = vm.addr(ownerKey);
        agent = vm.addr(agentKey);

        entryPoint = new EntryPoint();
        factory = new PurserFactory(IEntryPoint(address(entryPoint)));
        account = factory.createAccount(owner, 0);
        token = new MockToken();
        shop = new Shop();

        vm.deal(address(account), 10 ether);
        token.mint(address(account), 1000e18);

        vm.prank(owner);
        account.addSession(agent, defaultConfig());
    }

    function defaultConfig() internal view returns (IPurserAccount.SessionConfig memory config) {
        config.validAfter = 0;
        config.validUntil = uint48(block.timestamp + 30 days);
        config.period = DAY;
        config.label = "shopping agent";

        config.permissions = new IPurserAccount.Permission[](4);
        config.permissions[0] = IPurserAccount.Permission(merchant, bytes4(0));
        config.permissions[1] = IPurserAccount.Permission(address(shop), Shop.buy.selector);
        config.permissions[2] = IPurserAccount.Permission(address(token), IERC20.transfer.selector);
        config.permissions[3] = IPurserAccount.Permission(address(token), IERC20.approve.selector);

        config.limits = new IPurserAccount.Limit[](2);
        config.limits[0] = IPurserAccount.Limit(address(0), ETH_PER_TX, ETH_PER_DAY);
        config.limits[1] = IPurserAccount.Limit(address(token), TOKEN_PER_TX, TOKEN_PER_DAY);
    }

    // ---------------------------------------------------------------------------------------------
    // Call builders
    // ---------------------------------------------------------------------------------------------

    function one(address target, uint256 value, bytes memory data)
        internal
        pure
        returns (IPurserAccount.Call[] memory calls)
    {
        calls = new IPurserAccount.Call[](1);
        calls[0] = IPurserAccount.Call(target, value, data);
    }

    function payEth(address to, uint256 amount) internal pure returns (IPurserAccount.Call[] memory) {
        return one(to, amount, "");
    }

    function payToken(address to, uint256 amount) internal view returns (IPurserAccount.Call[] memory) {
        return one(address(token), 0, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    // ---------------------------------------------------------------------------------------------
    // User operations
    // ---------------------------------------------------------------------------------------------

    function buildOp(address sender, IPurserAccount.Call[] memory calls)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = sender;
        op.nonce = entryPoint.getNonce(sender, 0);
        op.callData = abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(calls));
        op.accountGasLimits = bytes32((uint256(400_000) << 128) | uint256(600_000));
        op.preVerificationGas = 60_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(2 gwei));
    }

    function sign(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash.toEthSignedMessageHash());
        return abi.encodePacked(r, s, v);
    }

    function ownerSig(PackedUserOperation memory op) internal view returns (bytes memory) {
        return abi.encodePacked(uint8(0), sign(ownerKey, entryPoint.getUserOpHash(op)));
    }

    function sessionSig(PackedUserOperation memory op, uint256 key) internal view returns (bytes memory) {
        return abi.encodePacked(uint8(1), vm.addr(key), sign(key, entryPoint.getUserOpHash(op)));
    }

    function approvedSig(PackedUserOperation memory op, uint256 key) internal view returns (bytes memory) {
        bytes32 hash = entryPoint.getUserOpHash(op);
        return abi.encodePacked(uint8(2), vm.addr(key), sign(key, hash), sign(ownerKey, hash));
    }

    function submit(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        entryPoint.handleOps(ops, bundler);
    }

    /// @dev Submits and returns whether the operation's execution succeeded (validation must pass).
    function submitAndGetSuccess(PackedUserOperation memory op) internal returns (bool success) {
        vm.recordLogs();
        submit(op);
        bytes32 sigTopic = IEntryPoint.UserOperationEvent.selector;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sigTopic) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                return success;
            }
        }
        revert("no UserOperationEvent");
    }

    function agentOp(IPurserAccount.Call[] memory calls)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = buildOp(address(account), calls);
        op.signature = sessionSig(op, agentKey);
    }

    function spent(address tokenAddr) internal view returns (uint256 remaining) {
        (, remaining,) = account.getBudget(agent, tokenAddr);
    }
}
