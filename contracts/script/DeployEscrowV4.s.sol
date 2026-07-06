// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MatchEscrow} from "../src/MatchEscrow.sol";

/// @notice Audit-M1 contract pass: MatchEscrow v4 next to the EXISTING
///         (repetition-aware) ReplayVerifier, treasury and stake token.
///         Single behavioural change vs v3: `voidExpired` no longer accepts a
///         Proposed match — a losing player could void a legitimate claim away
///         after the TTL and escape with a refund. A Proposed match is never
///         stuck: {finalize} is permissionless and has no deadline once the
///         challenge window closes. Economics identical (rake 11%, 600s
///         window, 86400s TTLs).
///
/// Env:
///   PRIVATE_KEY (required)  deployer key (0x-prefixed)
///   VERIFIER    (required)  existing ReplayVerifier (repetition-aware v2)
///   TREASURY    (required)  existing Treasury
///   TOKEN       (required)  stake token to allow (aUSD)
///   RAKE_BPS    (optional, default 1100 = 11%)
///   WINDOW      (optional, default 600s challenge window)
///   TTL         (optional, default 86400s active-match TTL; openTtl matches)
///
/// Run (Celo Sepolia):
///   forge script script/DeployEscrowV4.s.sol --rpc-url $CELO_SEPOLIA_RPC --broadcast
contract DeployEscrowV4 is Script {
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

        console2.log("MatchEscrow v4:", address(escrow));
        console2.log("verifier (reused):", verifier);
        console2.log("rakeBps:", rakeBps);
        console2.log("openTtl:", escrow.openTtl());
        console2.log("token allowed:", escrow.allowedToken(token));
    }
}
