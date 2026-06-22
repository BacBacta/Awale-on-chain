// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TournamentEscrow} from "../src/TournamentEscrow.sol";

/// @notice Deploys TournamentEscrow and (optionally) allows a staking token and
///         opens a first Sit-and-Go so the lobby has something to show.
///
/// Env:
///   PRIVATE_KEY (required)  deployer key
///   TREASURY    (required)  fee sink (reuse the MatchEscrow Treasury)
///   OPERATOR    (optional)  settlement coordinator that finalises standings; defaults to deployer
///   OWNER       (optional)  admin; defaults to deployer
///   STAKE_TOKEN (optional)  stablecoin to allow + use for the seed tournament
///   ENTRY_FEE   (optional, default 1e6)   entry fee in token units (1 USDC @ 6-dec)
///   MAX_PLAYERS (optional, default 8)     field size
///   CUT_BPS     (optional, default 800)   protocol cut (8%)
///
/// Run (Celo Sepolia):
///   forge script script/DeployTournament.s.sol --rpc-url $CELO_SEPOLIA_RPC --broadcast --verify
contract DeployTournament is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address treasury = vm.envAddress("TREASURY");
        address operator = vm.envOr("OPERATOR", deployer);
        address owner = vm.envOr("OWNER", deployer);
        address token = vm.envOr("STAKE_TOKEN", address(0));
        uint128 entryFee = uint128(vm.envOr("ENTRY_FEE", uint256(1e6)));
        uint32 maxPlayers = uint32(vm.envOr("MAX_PLAYERS", uint256(8)));
        uint16 cutBps = uint16(vm.envOr("CUT_BPS", uint256(800)));

        vm.startBroadcast(pk);

        TournamentEscrow tourney = new TournamentEscrow(treasury, operator, owner);

        // owner == deployer here, so we can allow the token and seed a table in one go
        if (token != address(0) && owner == deployer) {
            tourney.setTokenAllowed(token, true);

            if (operator == deployer) {
                uint16[] memory payout = new uint16[](2);
                payout[0] = 6500; // 1st 65%
                payout[1] = 3500; // 2nd 35%
                uint256 id = tourney.createTournament(
                    token, entryFee, maxPlayers, cutBps, 1 hours, 1 days, payout
                );
                console2.log("Seed tournament id:", id);
            }
        }

        vm.stopBroadcast();

        console2.log("TournamentEscrow:", address(tourney));
        console2.log("Treasury:        ", treasury);
        console2.log("Operator:        ", operator);
    }
}
