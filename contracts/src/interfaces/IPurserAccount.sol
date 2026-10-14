// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Purser account types, events and errors
/// @notice A session key belongs to one agent. Its policy says which contracts and functions it may
///         call, how much of each token it may move per transaction and per period, and when the
///         key is valid. Anything outside the budget needs the owner's co-signature.
interface IPurserAccount {
    /// @notice One call made by the account.
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @notice Permission to call `selector` on `target`.
    /// @dev `ANY_SELECTOR` allows every function on the target. `TRANSFER_SELECTOR` (zero) allows
    ///      plain ETH transfers with empty calldata.
    struct Permission {
        address target;
        bytes4 selector;
    }

    /// @notice Spending limit for one token. `token == address(0)` is native ETH.
    struct Limit {
        address token;
        uint128 perTx;
        uint128 perPeriod;
    }

    /// @notice Everything the owner sets when granting a session key to an agent.
    struct SessionConfig {
        uint48 validAfter;
        uint48 validUntil;
        uint32 period;
        Permission[] permissions;
        Limit[] limits;
        string label;
    }

    /// @notice Stored state of a session key.
    struct Session {
        bool active;
        uint32 epoch;
        uint32 period;
        uint48 validAfter;
        uint48 validUntil;
    }

    /// @notice Stored budget for one session key and token.
    struct Budget {
        bool enabled;
        uint48 periodStart;
        uint128 perTx;
        uint128 perPeriod;
        uint128 spent;
    }

    /// @notice Who signed a user operation.
    enum SignerMode {
        Owner,
        Session,
        SessionWithOwnerApproval
    }

    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event SessionAdded(
        address indexed key, string label, uint48 validAfter, uint48 validUntil, uint32 period
    );
    event SessionRevoked(address indexed key);
    event Frozen(bool frozen);
    event Spent(
        address indexed key,
        address indexed token,
        uint256 amount,
        uint256 spentInPeriod,
        bool approvedByOwner
    );
    event Executed(
        address indexed signer, SignerMode mode, address indexed target, uint256 value, bytes4 selector
    );

    error NotOwner();
    error NotEntryPoint();
    error InvalidSignatureLength();
    error UnknownSignerMode(uint8 mode);
    error UnsupportedCallData();
    error SessionNotActive(address key);
    error AccountFrozen();
    error SelfCallNotAllowed();
    error CallNotAllowed(address target, bytes4 selector);
    error TokenNotAllowed(address token);
    error OverTransactionLimit(address token, uint256 amount, uint256 limit);
    error OverPeriodBudget(address token, uint256 requested, uint256 remaining);
    error InvalidSessionConfig();
    error ZeroAddress();
}
