// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {BaseAccount} from "account-abstraction/core/BaseAccount.sol";
import {
    SIG_VALIDATION_FAILED,
    SIG_VALIDATION_SUCCESS,
    _packValidationData
} from "account-abstraction/core/Helpers.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {TokenCallbackHandler} from "account-abstraction/samples/callback/TokenCallbackHandler.sol";

import {IPurserAccount} from "./interfaces/IPurserAccount.sol";

/// @title PurserAccount
/// @notice ERC-4337 (v0.7) smart account that lets AI agents spend within limits set by a human owner.
///
/// Signature formats (`userOp.signature`):
///   - owner:                     0x00 | ownerSig(65)
///   - session key:               0x01 | key(20) | sessionSig(65)
///   - session key + owner OK:    0x02 | key(20) | sessionSig(65) | ownerSig(65)
/// Every signature is an EIP-191 personal signature over the user operation hash.
///
/// Call data for user operations is `executeUserOp.selector | abi.encode(Call[])`. The EntryPoint then
/// hands the whole user operation to `executeUserOp`, which is where budgets are enforced: budgets need
/// `block.timestamp`, which the ERC-7562 validation rules forbid. Validation still checks the signature,
/// the session window, the allow-list and per-transaction caps, so a disallowed operation is rejected
/// before any gas is charged.
contract PurserAccount is
    IPurserAccount,
    BaseAccount,
    IAccountExecute,
    IERC1271,
    TokenCallbackHandler,
    UUPSUpgradeable,
    Initializable
{
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    /// @notice Selector value that allows any function on a target.
    bytes4 public constant ANY_SELECTOR = 0xffffffff;
    /// @notice Selector value for a plain ETH transfer (empty calldata).
    bytes4 public constant TRANSFER_SELECTOR = bytes4(0);

    bytes4 private constant ERC20_TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 private constant ERC20_APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 private constant ERC20_TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256)

    uint256 private constant OWNER_SIG_LENGTH = 66;
    uint256 private constant SESSION_SIG_LENGTH = 86;
    uint256 private constant APPROVED_SIG_LENGTH = 151;

    IEntryPoint private immutable _entryPoint;

    address public owner;
    bool public frozen;

    mapping(address key => Session) private _sessions;
    mapping(
        address key => mapping(uint32 epoch => mapping(address target => mapping(bytes4 selector => bool)))
    ) private _allowed;
    mapping(address key => mapping(uint32 epoch => mapping(address token => Budget))) private _budgets;
    mapping(address key => mapping(uint32 epoch => address[] tokens)) private _budgetTokens;
    address[] private _sessionKeys;
    mapping(address key => bool) private _known;

    modifier onlyOwner() {
        if (msg.sender != owner && msg.sender != address(this)) revert NotOwner();
        _;
    }

    constructor(IEntryPoint anEntryPoint) {
        _entryPoint = anEntryPoint;
        _disableInitializers();
    }

    receive() external payable {}

    /// @notice Sets the owner of a freshly deployed proxy. Called once by the factory.
    function initialize(address anOwner) external initializer {
        if (anOwner == address(0)) revert ZeroAddress();
        owner = anOwner;
        emit OwnerChanged(address(0), anOwner);
    }

    /// @inheritdoc BaseAccount
    function entryPoint() public view override returns (IEntryPoint) {
        return _entryPoint;
    }

    // ---------------------------------------------------------------------------------------------
    // Owner administration
    // ---------------------------------------------------------------------------------------------

    /// @notice Grants (or replaces) a session key. Replacing a key wipes its old permissions and budgets.
    function addSession(address key, SessionConfig calldata config) external onlyOwner {
        if (key == address(0) || key == owner) revert ZeroAddress();
        uint48 validUntil = config.validUntil == 0 ? type(uint48).max : config.validUntil;
        if (validUntil <= config.validAfter) revert InvalidSessionConfig();
        if (config.limits.length > 0 && config.period == 0) revert InvalidSessionConfig();

        Session storage s = _sessions[key];
        uint32 epoch = s.epoch + 1;
        _sessions[key] = Session({
            active: true,
            epoch: epoch,
            period: config.period,
            validAfter: config.validAfter,
            validUntil: validUntil
        });

        for (uint256 i; i < config.permissions.length; ++i) {
            Permission calldata p = config.permissions[i];
            if (p.target == address(0) || p.target == address(this)) revert InvalidSessionConfig();
            _allowed[key][epoch][p.target][p.selector] = true;
        }
        for (uint256 i; i < config.limits.length; ++i) {
            Limit calldata l = config.limits[i];
            if (l.perPeriod == 0 || (l.perTx != 0 && l.perTx > l.perPeriod)) revert InvalidSessionConfig();
            Budget storage b = _budgets[key][epoch][l.token];
            if (b.enabled) revert InvalidSessionConfig();
            _budgets[key][epoch][l.token] =
                Budget({enabled: true, periodStart: 0, perTx: l.perTx, perPeriod: l.perPeriod, spent: 0});
            _budgetTokens[key][epoch].push(l.token);
        }

        if (!_known[key]) {
            _known[key] = true;
            _sessionKeys.push(key);
        }
        emit SessionAdded(key, config.label, config.validAfter, validUntil, config.period);
    }

    /// @notice Revokes a session key immediately.
    function revokeSession(address key) external onlyOwner {
        if (!_sessions[key].active) revert SessionNotActive(key);
        _sessions[key].active = false;
        emit SessionRevoked(key);
    }

    /// @notice Kill switch: while frozen, no session key can do anything. The owner still can.
    function setFrozen(bool value) external onlyOwner {
        frozen = value;
        emit Frozen(value);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Lets the owner act from their own wallet, without a bundler.
    function executeByOwner(Call[] calldata calls) external onlyOwner {
        for (uint256 i; i < calls.length; ++i) {
            _call(calls[i]);
            emit Executed(
                msg.sender, SignerMode.Owner, calls[i].target, calls[i].value, _selector(calls[i].data)
            );
        }
    }

    // ---------------------------------------------------------------------------------------------
    // ERC-4337
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc BaseAccount
    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        view
        override
        returns (uint256 validationData)
    {
        bytes calldata sig = userOp.signature;
        if (sig.length == 0) return SIG_VALIDATION_FAILED;
        bytes32 hash = userOpHash.toEthSignedMessageHash();
        uint8 mode = uint8(sig[0]);

        if (mode == uint8(SignerMode.Owner)) {
            if (sig.length != OWNER_SIG_LENGTH) return SIG_VALIDATION_FAILED;
            return _recovers(hash, sig[1:], owner) ? SIG_VALIDATION_SUCCESS : SIG_VALIDATION_FAILED;
        }
        if (mode > uint8(SignerMode.SessionWithOwnerApproval)) return SIG_VALIDATION_FAILED;

        bool approved = mode == uint8(SignerMode.SessionWithOwnerApproval);
        if (sig.length != (approved ? APPROVED_SIG_LENGTH : SESSION_SIG_LENGTH)) {
            return SIG_VALIDATION_FAILED;
        }
        address key = address(bytes20(sig[1:21]));
        if (!_recovers(hash, sig[21:86], key)) return SIG_VALIDATION_FAILED;
        if (approved && !_recovers(hash, sig[86:151], owner)) return SIG_VALIDATION_FAILED;

        Session memory s = _sessions[key];
        if (!s.active) return SIG_VALIDATION_FAILED;
        if (frozen) revert AccountFrozen();

        Call[] memory calls = _decodeCalls(userOp.callData);
        for (uint256 i; i < calls.length; ++i) {
            _checkCall(key, s.epoch, calls[i], !approved);
        }
        return _packValidationData(false, s.validUntil, s.validAfter);
    }

    /// @inheritdoc IAccountExecute
    function executeUserOp(PackedUserOperation calldata userOp, bytes32) external override {
        if (msg.sender != address(_entryPoint)) revert NotEntryPoint();
        Call[] memory calls = _decodeCalls(userOp.callData);
        bytes calldata sig = userOp.signature;
        SignerMode mode = SignerMode(uint8(sig[0]));

        if (mode == SignerMode.Owner) {
            for (uint256 i; i < calls.length; ++i) {
                _call(calls[i]);
                emit Executed(owner, mode, calls[i].target, calls[i].value, _selector(calls[i].data));
            }
            return;
        }

        address key = address(bytes20(sig[1:21]));
        bool approved = mode == SignerMode.SessionWithOwnerApproval;
        // Re-checked here: an owner operation earlier in the same bundle may have revoked or frozen.
        Session memory s = _sessions[key];
        if (!s.active) revert SessionNotActive(key);
        if (frozen) revert AccountFrozen();

        // Check and record the whole batch before making any call (checks-effects-interactions).
        for (uint256 i; i < calls.length; ++i) {
            Call memory c = calls[i];
            _checkCall(key, s.epoch, c, !approved);
            if (c.value > 0) _spend(key, s, address(0), c.value, approved);
            (address token, uint256 amount) = _tokenSpend(c);
            if (amount > 0) _spend(key, s, token, amount, approved);
        }
        for (uint256 i; i < calls.length; ++i) {
            _call(calls[i]);
            emit Executed(key, mode, calls[i].target, calls[i].value, _selector(calls[i].data));
        }
    }

    // ---------------------------------------------------------------------------------------------
    // ERC-1271
    // ---------------------------------------------------------------------------------------------

    /// @notice Signatures made by the owner are valid for the account (for dapps that check ERC-1271).
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = hash.tryRecover(signature);
        return err == ECDSA.RecoverError.NoError && recovered == owner
            ? this.isValidSignature.selector
            : bytes4(0xffffffff);
    }

    // ---------------------------------------------------------------------------------------------
    // Views for clients and the console
    // ---------------------------------------------------------------------------------------------

    function sessionKeys() external view returns (address[] memory) {
        return _sessionKeys;
    }

    function getSession(address key) external view returns (Session memory) {
        return _sessions[key];
    }

    function isAllowed(address key, address target, bytes4 selector) public view returns (bool) {
        uint32 epoch = _sessions[key].epoch;
        return _allowed[key][epoch][target][selector] || _allowed[key][epoch][target][ANY_SELECTOR];
    }

    /// @notice Budget of a session key for a token, with the spend of the current period.
    /// @return budget the stored limits; `spent` is reset to zero if the period has rolled over.
    /// @return remaining what the key can still spend in the current period.
    /// @return resetsAt when the current period ends (0 if nothing was spent yet).
    function getBudget(address key, address token)
        public
        view
        returns (Budget memory budget, uint256 remaining, uint256 resetsAt)
    {
        Session memory s = _sessions[key];
        budget = _budgets[key][s.epoch][token];
        if (!budget.enabled) return (budget, 0, 0);
        if (budget.periodStart == 0 || block.timestamp >= uint256(budget.periodStart) + s.period) {
            budget.spent = 0;
            budget.periodStart = 0;
        }
        remaining = budget.perPeriod - budget.spent;
        resetsAt = budget.periodStart == 0 ? 0 : uint256(budget.periodStart) + s.period;
    }

    /// @notice Tokens that have a budget for a session key (address(0) is ETH).
    function budgetTokens(address key) external view returns (address[] memory) {
        return _budgetTokens[key][_sessions[key].epoch];
    }

    /// @notice Dry run of a batch for a session key, without the owner's approval.
    /// @return ok whether the batch would pass the policy now.
    /// @return reason the custom error the account would revert with, if not.
    function previewCalls(address key, Call[] calldata calls)
        external
        view
        returns (bool ok, bytes memory reason)
    {
        try this.checkCallsExternal(key, calls) {
            return (true, "");
        } catch (bytes memory err) {
            return (false, err);
        }
    }

    /// @dev Only callable by this contract, through `previewCalls`.
    function checkCallsExternal(address key, Call[] calldata calls) external view {
        if (msg.sender != address(this)) revert NotOwner();
        Session memory s = _sessions[key];
        if (!s.active || block.timestamp < s.validAfter || block.timestamp > s.validUntil) {
            revert SessionNotActive(key);
        }
        if (frozen) revert AccountFrozen();
        address[] memory tokens = _budgetTokens[key][s.epoch];
        uint256[] memory totals = new uint256[](tokens.length);
        for (uint256 i; i < calls.length; ++i) {
            Call calldata c = calls[i];
            _checkCall(key, s.epoch, c, true);
            (address token, uint256 amount) = _tokenSpend(c);
            for (uint256 t; t < tokens.length; ++t) {
                if (tokens[t] == address(0)) totals[t] += c.value;
                if (amount > 0 && tokens[t] == token) totals[t] += amount;
            }
        }
        for (uint256 t; t < tokens.length; ++t) {
            if (totals[t] == 0) continue;
            (, uint256 remaining,) = getBudget(key, tokens[t]);
            if (totals[t] > remaining) revert OverPeriodBudget(tokens[t], totals[t], remaining);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    /// @dev Allow-list and per-transaction caps. Needs no clock, so it is safe in validation.
    function _checkCall(address key, uint32 epoch, Call memory c, bool enforceCaps) internal view {
        if (c.target == address(this)) revert SelfCallNotAllowed();
        bytes4 sel = _selector(c.data);
        if (!_allowed[key][epoch][c.target][sel] && !_allowed[key][epoch][c.target][ANY_SELECTOR]) {
            revert CallNotAllowed(c.target, sel);
        }
        if (c.value > 0) _checkCap(key, epoch, address(0), c.value, enforceCaps);
        (address token, uint256 amount) = _tokenSpend(c);
        if (amount > 0) _checkCap(key, epoch, token, amount, enforceCaps);
    }

    function _checkCap(address key, uint32 epoch, address token, uint256 amount, bool enforceCaps)
        internal
        view
    {
        Budget storage b = _budgets[key][epoch][token];
        if (!b.enabled) revert TokenNotAllowed(token);
        if (enforceCaps && b.perTx != 0 && amount > b.perTx) {
            revert OverTransactionLimit(token, amount, b.perTx);
        }
    }

    function _spend(address key, Session memory s, address token, uint256 amount, bool approved) internal {
        Budget storage b = _budgets[key][s.epoch][token];
        if (b.periodStart == 0 || block.timestamp >= uint256(b.periodStart) + s.period) {
            b.periodStart = uint48(block.timestamp);
            b.spent = 0;
        }
        if (!approved) {
            uint256 remaining = b.perPeriod - b.spent;
            if (amount > remaining) revert OverPeriodBudget(token, amount, remaining);
            // amount <= remaining <= perPeriod, which is a uint128.
            // forge-lint: disable-next-line(unsafe-typecast)
            b.spent += uint128(amount);
        }
        emit Spent(key, token, amount, b.spent, approved);
    }

    /// @dev Tokens moved by an ERC-20 call. Approvals count as spending: an allowance is money out.
    function _tokenSpend(Call memory c) internal view returns (address token, uint256 amount) {
        bytes memory data = c.data;
        if (data.length < 68) return (address(0), 0);
        bytes4 sel = _selector(data);
        if (sel == ERC20_TRANSFER || sel == ERC20_APPROVE) {
            assembly ("memory-safe") {
                amount := mload(add(data, 68))
            }
            return (c.target, amount);
        }
        if (sel == ERC20_TRANSFER_FROM && data.length >= 100) {
            address from;
            assembly ("memory-safe") {
                from := mload(add(data, 36))
                amount := mload(add(data, 100))
            }
            if (from == address(this)) return (c.target, amount);
        }
        return (address(0), 0);
    }

    function _decodeCalls(bytes calldata callData) internal pure returns (Call[] memory) {
        if (callData.length < 4 || bytes4(callData[:4]) != IAccountExecute.executeUserOp.selector) {
            revert UnsupportedCallData();
        }
        return abi.decode(callData[4:], (Call[]));
    }

    function _call(Call memory c) internal {
        // Targets are the owner's choice, or on the session key's allow-list and within its budget.
        // forge-lint: disable-next-line(arbitrary-send-eth)
        (bool ok, bytes memory result) = c.target.call{value: c.value}(c.data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }
    }

    function _selector(bytes memory data) internal pure returns (bytes4 sel) {
        if (data.length < 4) return TRANSFER_SELECTOR;
        assembly ("memory-safe") {
            sel := mload(add(data, 32))
        }
    }

    function _recovers(bytes32 hash, bytes calldata sig, address expected) internal pure returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = hash.tryRecover(sig);
        return err == ECDSA.RecoverError.NoError && recovered == expected && expected != address(0);
    }

    /// @inheritdoc UUPSUpgradeable
    function _authorizeUpgrade(address) internal view override onlyOwner {}
}
