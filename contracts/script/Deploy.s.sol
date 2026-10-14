// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

import {PurserFactory} from "../src/PurserFactory.sol";

/// @notice Deploys the Purser factory (and its account implementation) with CREATE2, so the factory
///         has the same address on every chain that has the canonical EntryPoint v0.7.
///
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
///
/// On a local chain without the canonical EntryPoint, a fresh EntryPoint is deployed first.
/// Addresses are written to deployments/<chainId>.json.
contract Deploy is Script {
    address internal constant CANONICAL_ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    /// @dev The deterministic deployment proxy present on Anvil and on most public chains.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant SALT = keccak256("purser.factory.v1");

    function run() external returns (PurserFactory factory, address entryPoint) {
        entryPoint = vm.envOr("ENTRY_POINT", CANONICAL_ENTRY_POINT);
        require(CREATE2_DEPLOYER.code.length > 0, "no CREATE2 deployer on this chain");

        vm.startBroadcast();
        if (entryPoint.code.length == 0) {
            require(block.chainid == 31_337, "no EntryPoint v0.7 on this chain");
            entryPoint = address(new EntryPoint());
            console2.log("Deployed local EntryPoint", entryPoint);
        }

        // Called explicitly, so the address is the same on every chain with the same EntryPoint.
        bytes memory initCode = abi.encodePacked(type(PurserFactory).creationCode, abi.encode(entryPoint));
        address predicted = vm.computeCreate2Address(SALT, keccak256(initCode), CREATE2_DEPLOYER);
        if (predicted.code.length == 0) {
            (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initCode));
            require(ok && predicted.code.length > 0, "factory deployment failed");
        } else {
            console2.log("Factory already deployed");
        }
        factory = PurserFactory(predicted);
        vm.stopBroadcast();

        console2.log("EntryPoint", entryPoint);
        console2.log("PurserFactory", address(factory));
        console2.log("PurserAccount implementation", address(factory.accountImplementation()));

        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "entryPoint", entryPoint);
        vm.serializeAddress(json, "accountImplementation", address(factory.accountImplementation()));
        string memory out = vm.serializeAddress(json, "factory", address(factory));
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
