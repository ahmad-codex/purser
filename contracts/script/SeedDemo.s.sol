// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PurserAccount} from "../src/PurserAccount.sol";
import {PurserFactory} from "../src/PurserFactory.sol";
import {IPurserAccount} from "../src/interfaces/IPurserAccount.sol";
import {DemoShop, DemoToken} from "./DemoContracts.sol";

/// @notice Sets up a demo: an account for the owner, funded with ETH and demo dollars, a shop, and a
///         session key for an agent with a daily budget. Run after Deploy.s.sol.
///
///   OWNER_PRIVATE_KEY=... AGENT_ADDRESS=... forge script script/SeedDemo.s.sol --rpc-url anvil --broadcast
///
/// Writes deployments/<chainId>.demo.json.
contract SeedDemo is Script {
    function run() external {
        uint256 ownerKey = vm.envUint("OWNER_PRIVATE_KEY");
        address owner = vm.addr(ownerKey);
        address agent = vm.envAddress("AGENT_ADDRESS");
        address merchant = vm.envOr("MERCHANT_ADDRESS", address(0x000000000000000000000000000000000000bEEF));
        uint256 fundEth = vm.envOr("FUND_ETH_WEI", uint256(5 ether));

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        PurserFactory factory = PurserFactory(vm.parseJsonAddress(vm.readFile(path), ".factory"));

        vm.startBroadcast(ownerKey);
        PurserAccount account = factory.createAccount(owner, 0);
        DemoToken usd = new DemoToken();
        DemoShop shop = new DemoShop();
        usd.mint(address(account), 1000e18);
        if (address(account).balance < fundEth) {
            (bool ok,) = address(account).call{value: fundEth - address(account).balance}("");
            require(ok, "funding failed");
        }
        account.addSession(
            agent,
            _policy(
                merchant,
                address(usd),
                address(shop),
                uint128(vm.envOr("ETH_PER_TX_WEI", uint256(0.05 ether))),
                uint128(vm.envOr("ETH_PER_PERIOD_WEI", uint256(0.1 ether)))
            )
        );
        vm.stopBroadcast();

        console2.log("Account", address(account));
        console2.log("Agent", agent);
        console2.log("Demo USD", address(usd));
        console2.log("Shop", address(shop));

        string memory json = "demo";
        // Clients read account events from here instead of scanning the whole chain.
        vm.serializeUint(json, "fromBlock", block.number);
        vm.serializeAddress(json, "owner", owner);
        vm.serializeAddress(json, "agent", agent);
        vm.serializeAddress(json, "account", address(account));
        vm.serializeAddress(json, "merchant", merchant);
        vm.serializeAddress(json, "token", address(usd));
        string memory out = vm.serializeAddress(json, "shop", address(shop));
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), ".demo.json"));
    }

    function _policy(address merchant, address usd, address shop, uint128 ethPerTx, uint128 ethPerPeriod)
        internal
        view
        returns (IPurserAccount.SessionConfig memory config)
    {
        config.validUntil = uint48(block.timestamp + 30 days);
        config.period = 1 days;
        config.label = "demo agent";

        config.permissions = new IPurserAccount.Permission[](4);
        config.permissions[0] = IPurserAccount.Permission(merchant, bytes4(0));
        config.permissions[1] = IPurserAccount.Permission(usd, IERC20.transfer.selector);
        config.permissions[2] = IPurserAccount.Permission(shop, DemoShop.buy.selector);
        config.permissions[3] = IPurserAccount.Permission(usd, IERC20.approve.selector);

        config.limits = new IPurserAccount.Limit[](2);
        config.limits[0] = IPurserAccount.Limit(address(0), ethPerTx, ethPerPeriod);
        config.limits[1] = IPurserAccount.Limit(usd, 50e18, 100e18);
    }
}
