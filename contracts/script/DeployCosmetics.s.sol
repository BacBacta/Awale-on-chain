// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Cosmetics} from "../src/Cosmetics.sol";

/// @notice Deploys the Cosmetics (ERC-1155 skins) contract and seeds the
///         catalogue with the app's premium board/seed skins. Primary sales are
///         paid in `CURRENCY` to `TREASURY`; secondary royalties via ERC-2981.
///
/// Env:
///   PRIVATE_KEY (required)   deployer key (0x-prefixed)
///   OWNER       (optional)   contract owner; defaults to deployer
///   CURRENCY    (required)   stablecoin accepted for purchases (e.g. league aUSD)
///   TREASURY    (required)   receives primary-sale proceeds
///   ROYALTY_BPS (optional, default 500 = 5%)
///   URI         (optional)   ERC-1155 metadata uri template
///
/// Run (Celo Sepolia):
///   forge script script/DeployCosmetics.s.sol --rpc-url $CELO_SEPOLIA_RPC --broadcast
contract DeployCosmetics is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = vm.envOr("OWNER", deployer);
        address currency = vm.envAddress("CURRENCY");
        address treasury = vm.envAddress("TREASURY");
        uint96 royaltyBps = uint96(vm.envOr("ROYALTY_BPS", uint256(500)));
        string memory uri = vm.envOr("URI", string("https://awale-on-chain.vercel.app/assets/skin-{id}.json"));

        vm.startBroadcast(pk);

        Cosmetics cos = new Cosmetics("Awale Skins", uri, currency, treasury, treasury, royaltyBps, owner);

        // catalogue must match packages/app/src/lib/skins.ts (ids + prices, 18-dec).
        // The shop reads these on-chain prices as the source of truth; they are
        // adjustable any time via setItemPrice (owner) without a redeploy.
        // board skins
        cos.createItem(1, 0.5 ether, 0); // Ebony
        cos.createItem(2, 0.5 ether, 0); // Pale Ash
        // seed skins
        cos.createItem(10, 0.25 ether, 0); // Jade
        cos.createItem(11, 0.25 ether, 0); // Pearl
        cos.createItem(12, 0.25 ether, 0); // Onyx

        vm.stopBroadcast();

        console2.log("Cosmetics:  ", address(cos));
        console2.log("currency:   ", currency);
        console2.log("treasury:   ", treasury);
    }
}
