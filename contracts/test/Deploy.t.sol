// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

contract DeployTest is Test {
    function test_localDeploy_wiresEverything() public {
        // hermetic: set every env var the script reads, so a developer's local
        // contracts/.env (which forge auto-loads) can't change the outcome.
        vm.setEnv("PRIVATE_KEY", "0x0000000000000000000000000000000000000000000000000000000000a11ce0");
        vm.setEnv("DEPLOY_MOCK_TOKENS", "false");
        address gov = address(0x60A);
        vm.setEnv("OWNER", vm.toString(gov));

        Deploy deployer = new Deploy();
        Deploy.Deployment memory d = deployer.run();

        // wiring
        assertEq(address(d.escrow.verifier()), address(d.verifier), "escrow points at verifier");
        assertEq(d.escrow.treasury(), address(d.treasury), "escrow points at treasury");

        // parameters
        assertEq(d.escrow.rakeBps(), 250);
        assertEq(d.escrow.challengeWindow(), 600);
        assertEq(d.escrow.matchTtl(), 1 days);

        // ownership handed to governance
        assertEq(d.treasury.owner(), gov, "treasury owned by governance");
        assertEq(d.escrow.owner(), gov, "escrow ownership transferred to governance");

        // local network deploys and allowlists a single mock stablecoin
        assertEq(d.allowedTokens.length, 1);
        assertTrue(d.escrow.allowedToken(d.allowedTokens[0]), "mock stablecoin allowlisted");
    }
}
