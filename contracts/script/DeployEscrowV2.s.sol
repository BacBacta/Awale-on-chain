// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MatchEscrow} from "../src/MatchEscrow.sol";

/// @notice Pre-mainnet contract pass: deploys the upgraded MatchEscrow next to
///         the EXISTING verifier / treasury / stake token. Changes vs v1:
///          - rake ceiling 10% → 20%; deployed rake 11% (55% platform,
///            45% weekly-league pot per the product decision)
///          - voidExpired is permissionless: a keeper can free stuck stakes
///          - Open matches expire (openTtl): an unjoined table can always be
///            refunded to its creator by anyone after the deadline
///
/// Env:
///   PRIVATE_KEY (required)  deployer key (0x-prefixed)
///   VERIFIER    (required)  existing ReplayVerifier
///   TREASURY    (required)  existing Treasury
///   TOKEN       (required)  stake token to allow (aUSD)
///   RAKE_BPS    (optional, default 1100 = 11%)
///   WINDOW      (optional, default 600s challenge window)
///   TTL         (optional, default 86400s active-match TTL; openTtl matches)
///
/// Run (Celo Sepolia):
///   forge script script/DeployEscrowV2.s.sol --rpc-url $CELO_SEPOLIA_RPC --broadcast
contract DeployEscrowV2 is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address verifier = vm.envAddress("VERIFIER");
        address treasury = vm.envAddress("TREASURY");
        address token = vm.envAddress("TOKEN");
        uint16 rakeBps = uint16(vm.envOr("RAKE_BPS", uint256(1100)));
        uint64 window = uint64(vm.envOr("WINDOW", uint256(600)));
        uint64 ttl = uint64(vm.envOr("TTL", uint256(86400)));

        vm.startBroadcast(pk);
        MatchEscrow escrow = new MatchEscrow(verifier, treasury, rakeBps, window, ttl, deployer);
        escrow.setTokenAllowed(token, true);
        vm.stopBroadcast();

        console2.log("MatchEscrow v2:", address(escrow));
        console2.log("rakeBps:", rakeBps);
        console2.log("openTtl:", escrow.openTtl());
    }
}
