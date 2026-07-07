// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VRFFirstMover} from "../src/VRFFirstMover.sol";

/// @notice Deploy the VRF first-mover coin flip (scaffold). Needs a Chainlink
///         VRF v2.5 coordinator, a gas-lane keyHash, and a FUNDED subscription
///         on the target chain — after deploy, add this contract as a consumer
///         of that subscription and setRequester(escrowKeeper, true).
///
/// Env:
///   PRIVATE_KEY (required)  deployer key
///   OWNER       (optional)  owner (config + requester allowlist); default deployer
///   VRF_COORDINATOR (required)  Chainlink VRF v2.5 coordinator on this chain
///   VRF_KEYHASH     (required)  gas-lane keyHash
///   VRF_SUB_ID      (required)  funded subscription id
///
/// Run (Celo mainnet, once a subscription exists):
///   forge script script/DeployVRFFirstMover.s.sol --rpc-url $CELO_RPC --broadcast
contract DeployVRFFirstMover is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = vm.envOr("OWNER", deployer);
        address coordinator = vm.envAddress("VRF_COORDINATOR");
        bytes32 keyHash = vm.envBytes32("VRF_KEYHASH");
        uint256 subId = vm.envUint("VRF_SUB_ID");

        vm.startBroadcast(pk);
        VRFFirstMover vrf = new VRFFirstMover(coordinator, keyHash, subId, owner);
        vm.stopBroadcast();

        console2.log("VRFFirstMover:", address(vrf));
        console2.log("coordinator:  ", coordinator);
        console2.log("owner:        ", owner);
        console2.log("NEXT: add as VRF subscription consumer + setRequester(keeper, true)");
    }
}
