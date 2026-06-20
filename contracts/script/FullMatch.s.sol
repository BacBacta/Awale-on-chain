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

        // player1 approves, joins, and proposes player 0 (the human) as winner
        vm.startBroadcast(p1Pk);
        IERC20(usdm).approve(escrowAddr, stake);
        escrow.joinMatch(matchId, address(0x0000000000000000000000000000000000000002));
        // commitment = keccak of an empty move list (script only; real client passes the actual game hash)
        escrow.proposeResult(matchId, 0, keccak256(abi.encode(matchId, uint8(0), new uint8[](0))));
        vm.stopBroadcast();

        console2.log("joined + proposed winner=player0; finalize after the window");
    }
}
