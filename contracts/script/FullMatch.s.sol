// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MatchEscrow} from "../src/MatchEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Demo: a second player (P1_KEY) joins MATCH_ID and proposes player 0
///         (the human) as the winner. Run with the challenge window set low, then
///         call finalize() to pay the human out. Sequenced via one broadcast so
///         nonces stay in order.
contract FullMatch is Script {
    // demo script only — a real client MUST use fresh randomness per match
    // only player1's half: the creator's secret lives in their app, not here
    bytes32 internal constant SECRET1 = keccak256("awale.script.secret1");

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

        // player1 approves and joins, committing its half of the first-move flip
        vm.startBroadcast(p1Pk);
        IERC20(usdm).approve(escrowAddr, stake);
        escrow.joinMatch(matchId, address(0x0000000000000000000000000000000000000002), keccak256(abi.encode(SECRET1)));
        vm.stopBroadcast();

        // The script STOPS here. proposeResult requires the first move to be
        // fixed, and fixing it needs BOTH secrets — secret0 belongs to whoever
        // created the match in the app and is not this script's to know. Calling
        // proposeResult here would simply revert with "start not finalized".
        console2.log("joined. Match is Active, first move not yet fixed.");
        console2.log("Next: the creator reveals in the app; the server then calls");
        console2.log("finalizeStart(matchId, secret0, secret1). This script's half is:");
        console2.logBytes32(SECRET1);
    }
}
