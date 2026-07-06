// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MatchEscrow} from "../src/MatchEscrow.sol";
import {ReplayVerifier} from "../src/ReplayVerifier.sol";

/// @notice Anti-stall contract pass: deploys a FRESH ReplayVerifier (now mirrors
///         the threefold-repetition rule on-chain) and a MatchEscrow v3 wired to
///         it, next to the EXISTING treasury / stake token. Identical economics
///         to v2 (rake 11%, 600s challenge window, 86400s TTL) — the only change
///         is that a repetition-ended game now resolves to the seed-leader on the
///         challenge path instead of voiding.
///
/// Env:
///   PRIVATE_KEY (required)  deployer key (0x-prefixed)
///   TREASURY    (required)  existing Treasury
///   TOKEN       (required)  stake token to allow (aUSD)
///   RAKE_BPS    (optional, default 1100 = 11%)
///   WINDOW      (optional, default 600s challenge window)
///   TTL         (optional, default 86400s active-match TTL; openTtl matches)
///
/// Run (Celo Sepolia):
///   forge script script/DeployEscrowV3.s.sol --rpc-url $CELO_SEPOLIA_RPC --broadcast
contract DeployEscrowV3 is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address treasury = vm.envAddress("TREASURY");
        address token = vm.envAddress("TOKEN");
        uint16 rakeBps = uint16(vm.envOr("RAKE_BPS", uint256(1100)));
        uint64 window = uint64(vm.envOr("WINDOW", uint256(600)));
        uint64 ttl = uint64(vm.envOr("TTL", uint256(86400)));

        vm.startBroadcast(pk);
        ReplayVerifier verifier = new ReplayVerifier();
        MatchEscrow escrow = new MatchEscrow(address(verifier), treasury, rakeBps, window, ttl, deployer);
        escrow.setTokenAllowed(token, true);
        vm.stopBroadcast();

        console2.log("ReplayVerifier v2:", address(verifier));
        console2.log("MatchEscrow v3:", address(escrow));
        console2.log("rakeBps:", rakeBps);
        console2.log("openTtl:", escrow.openTtl());
        console2.log("token allowed:", escrow.allowedToken(token));
    }
}
