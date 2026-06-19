// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Hand ownership of MatchEscrow + Treasury to a timelock controlled by
///         a multisig (audit finding L-02). After this, every admin change
///         (rake, treasury, token allowlist, …) goes through the timelock delay
///         and the multisig.
///
/// Env: ESCROW_ADDRESS, TREASURY_ADDRESS, MULTISIG (proposer/executor),
///      TIMELOCK_DELAY (seconds, default 2 days), PRIVATE_KEY (current owner).
contract Govern is Script {
    function run() external returns (TimelockController timelock) {
        address escrow = vm.envAddress("ESCROW_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
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
        vm.stopBroadcast();

        console2.log("TimelockController:", address(timelock));
        console2.log("minDelay (s):      ", minDelay);
        console2.log("escrow owner ->    ", address(timelock));
        console2.log("treasury owner ->  ", address(timelock));
    }
}
