// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Hand ownership of EVERY privileged contract to a timelock controlled
///         by a multisig (audit finding L-02). After this, every admin change —
///         rake, treasury, token allowlist, WeeklyPrizes root/sweep, Cosmetics
///         mints — goes through the timelock delay and the multisig, and the
///         hot operational key can no longer touch funds or parameters.
///
/// @dev Transfers all FOUR ownables the operator holds. The two optional ones
///      (WeeklyPrizes, Cosmetics) are skipped when their env var is unset/zero,
///      so the script also works on an early deployment that lacks them.
///
/// Env:
///   ESCROW_ADDRESS        (required)  MatchEscrow (current: v5)
///   TREASURY_ADDRESS      (required)  Treasury.sol
///   WEEKLY_PRIZES_ADDRESS (optional)  WeeklyPrizes distributor
///   COSMETICS_ADDRESS     (optional)  Cosmetics
///   MULTISIG              (required)  the Safe — sole proposer + executor
///   TIMELOCK_DELAY        (optional)  seconds, default 2 days
///   PRIVATE_KEY           (required)  the CURRENT owner (operator) that still
///                                     holds all four; it signs the transfers
contract Govern is Script {
    function run() external returns (TimelockController timelock) {
        address escrow = vm.envAddress("ESCROW_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address weeklyPrizes = vm.envOr("WEEKLY_PRIZES_ADDRESS", address(0));
        address cosmetics = vm.envOr("COSMETICS_ADDRESS", address(0));
        address multisig = vm.envAddress("MULTISIG");
        uint256 minDelay = vm.envOr("TIMELOCK_DELAY", uint256(2 days));
        uint256 pk = vm.envUint("PRIVATE_KEY");

        address[] memory proposers = new address[](1);
        proposers[0] = multisig;
        address[] memory executors = new address[](1);
        executors[0] = multisig;

        vm.startBroadcast(pk);
        // admin = address(0): no extra admin, the timelock self-administers
        timelock = new TimelockController(minDelay, proposers, executors, address(0));
        Ownable(escrow).transferOwnership(address(timelock));
        Ownable(treasury).transferOwnership(address(timelock));
        if (weeklyPrizes != address(0)) Ownable(weeklyPrizes).transferOwnership(address(timelock));
        if (cosmetics != address(0)) Ownable(cosmetics).transferOwnership(address(timelock));
        vm.stopBroadcast();

        console2.log("TimelockController:", address(timelock));
        console2.log("minDelay (s):      ", minDelay);
        console2.log("escrow owner ->    ", address(timelock));
        console2.log("treasury owner ->  ", address(timelock));
        if (weeklyPrizes != address(0)) console2.log("weeklyPrizes owner ->", address(timelock));
        if (cosmetics != address(0)) console2.log("cosmetics owner ->  ", address(timelock));
    }
}
