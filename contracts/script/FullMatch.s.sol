// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MatchEscrow} from "../src/MatchEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Demo: a second player (P1_KEY) joins MATCH_ID. Settlement is no
///         longer an *assertion* — a winner must be proven, either by both
///         session keys co-signing the result (settleSigned) or by proving the
///         full signed terminal transcript on-chain (proposeResult→finalize).
///         So this demo stops at joining; drive settlement from the game client.
contract FullMatch is Script {
    function run() external {
        address escrowAddr = vm.envAddress("ESCROW");
        address usdm = vm.envAddress("USDM");
        uint256 matchId = vm.envUint("MATCH_ID");
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        uint256 p1Pk = vm.envUint("P1_KEY");
        address p1 = vm.addr(p1Pk);

        MatchEscrow escrow = MatchEscrow(escrowAddr);
        uint128 stake = escrow.getMatch(matchId).stake;
        console2.log("player1:", p1);
        console2.log("stake:", stake);

        // deployer tops up player1 with the stake token
        vm.startBroadcast(deployerPk);
        IERC20(usdm).transfer(p1, stake);
        vm.stopBroadcast();

        // player1 approves and joins. A winner can no longer be asserted here:
        // settle via settleSigned (both session keys sign the result) or prove a
        // full terminal transcript through proposeResult→finalize.
        vm.startBroadcast(p1Pk);
        IERC20(usdm).approve(escrowAddr, stake);
        escrow.joinMatch(matchId, address(0x0000000000000000000000000000000000000002));
        vm.stopBroadcast();

        console2.log("joined; settle via settleSigned or a proven terminal transcript");
    }
}
