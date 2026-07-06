// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MatchEscrow} from "../src/MatchEscrow.sol";

/// @notice Anti-theft pass: MatchEscrow v5 next to the EXISTING (repetition-aware)
///         ReplayVerifier, treasury and stake token.
///
///         Single behavioural change vs v4: the {challenge} caller gate is split.
///         The *terminal* branch (a full, doubly-signed transcript pays the
///         canonical winner) is now PERMISSIONLESS; only the *non-terminal void*
///         branch stays participant-only. Why it matters: v4 gated all of
///         `challenge` to match players (audit L-04). But L-04 was only ever
///         about the void/refund grief. Gating the terminal branch too silently
///         disabled the server keeper's anti-theft backstop — the keeper is not
///         a player, so it could not refute a losing opponent's
///         proposeResult(self)+finalize when the honest winner was offline for
///         the whole window. A terminal transcript can only enforce the true
///         result, so letting anyone submit it is safe and restores the
///         backstop. Economics identical (rake 11%, 600s window, 86400s TTLs).
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
///   forge script script/DeployEscrowV5.s.sol --rpc-url $CELO_SEPOLIA_RPC --broadcast
contract DeployEscrowV5 is Script {
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

        console2.log("MatchEscrow v5:", address(escrow));
        console2.log("verifier (reused):", verifier);
        console2.log("rakeBps:", rakeBps);
        console2.log("openTtl:", escrow.openTtl());
        console2.log("token allowed:", escrow.allowedToken(token));
    }
}
