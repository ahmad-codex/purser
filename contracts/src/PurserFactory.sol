// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

import {PurserAccount} from "./PurserAccount.sol";

/// @title PurserFactory
/// @notice Deploys Purser accounts behind ERC-1967 proxies at deterministic (CREATE2) addresses, so an
///         account's address is known, and can receive funds, before it exists.
contract PurserFactory {
    PurserAccount public immutable accountImplementation;

    event AccountCreated(address indexed account, address indexed owner, uint256 salt);

    constructor(IEntryPoint entryPoint) {
        accountImplementation = new PurserAccount(entryPoint);
    }

    /// @notice Deploys the account for `owner` and `salt`, or returns it if it already exists.
    /// @dev Safe to call from a user operation's initCode: it never reverts for an existing account.
    function createAccount(address owner, uint256 salt) external returns (PurserAccount account) {
        address addr = getAddress(owner, salt);
        if (addr.code.length > 0) return PurserAccount(payable(addr));
        account = PurserAccount(
            payable(new ERC1967Proxy{salt: bytes32(salt)}(
                    address(accountImplementation), abi.encodeCall(PurserAccount.initialize, (owner))
                ))
        );
        emit AccountCreated(address(account), owner, salt);
    }

    /// @notice The address `createAccount(owner, salt)` deploys to.
    function getAddress(address owner, uint256 salt) public view returns (address) {
        return Create2.computeAddress(
            bytes32(salt),
            keccak256(
                abi.encodePacked(
                    type(ERC1967Proxy).creationCode,
                    abi.encode(
                        address(accountImplementation), abi.encodeCall(PurserAccount.initialize, (owner))
                    )
                )
            )
        );
    }
}
