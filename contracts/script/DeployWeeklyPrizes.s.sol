// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {WeeklyPrizes} from "../src/WeeklyPrizes.sol";

/// @notice Deploy the WeeklyPrizes Merkle distributor — the trust-minimised
///         replacement for the custodial Weekly-race payout. The operator funds
///         a week's pot into this contract and publishes a Merkle root; winners
///         claim from the contract with a proof, so the money is escrowed and
///         the winners list is sealed on-chain.
///
/// Env:
///   PRIVATE_KEY (required)  deployer key (0x-prefixed)
///   OWNER       (optional)  owner that publishes rounds + sweeps; default deployer
///                           (set to the operator wallet on testnet; the
///                           timelock+multisig before mainnet — see Govern.s.sol)
///
/// Run (Celo Sepolia):
///   forge script script/DeployWeeklyPrizes.s.sol --rpc-url $CELO_SEPOLIA_RPC --broadcast
contract DeployWeeklyPrizes is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = vm.envOr("OWNER", deployer);

        vm.startBroadcast(pk);
        WeeklyPrizes dist = new WeeklyPrizes(owner);
        vm.stopBroadcast();

        console2.log("WeeklyPrizes:", address(dist));
        console2.log("owner:       ", owner);
    }
}
