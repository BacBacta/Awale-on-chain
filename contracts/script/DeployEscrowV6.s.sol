// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MatchEscrow} from "../src/MatchEscrow.sol";

/// @notice Friend-stakes pass: MatchEscrow v6 next to the EXISTING verifier,
///         treasury and stake token.
///
///         Single addition vs v5: INVITE-LOCKED matches for staked friend
///         games. `createMatchWithInvite(token, stake, session0, inviteHash)`
///         commits keccak256(code); only `joinMatchWithCode(id, session1, code)`
///         with the link's secret code can take the seat, and plain `joinMatch`
///         rejects locked matches. Without this, any lobby bot could take the
///         friend's seat the moment the match appeared on-chain — friend links
///         bypass the server's skill matchmaking, so an open seat is exactly
///         where a shark would camp. Everything else (11% rake, settlement,
///         cancel, TTL refunds, H-03 anti-theft) is identical to v5.
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
///   forge script script/DeployEscrowV6.s.sol --rpc-url $CELO_SEPOLIA_RPC --broadcast
contract DeployEscrowV6 is Script {
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

        console2.log("MatchEscrow v6:", address(escrow));
        console2.log("verifier (reused):", verifier);
        console2.log("rakeBps:", rakeBps);
        console2.log("token allowed:", escrow.allowedToken(token));
    }
}
