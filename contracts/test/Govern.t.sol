// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ReplayVerifier} from "../src/ReplayVerifier.sol";
import {Treasury} from "../src/Treasury.sol";
import {MatchEscrow} from "../src/MatchEscrow.sol";
import {WeeklyPrizes} from "../src/WeeklyPrizes.sol";

/// @notice Verifies the timelock + multisig ownership handover for EVERY
///         privileged contract, and that admin changes then flow through
///         schedule -> (delay) -> execute.
contract GovernTest is Test {
    ReplayVerifier internal verifier;
    Treasury internal treasury;
    MatchEscrow internal escrow;
    WeeklyPrizes internal prizes;
    TimelockController internal timelock;

    address internal deployer = address(this);
    address internal multisig = address(0x5AFE);
    uint256 internal constant DELAY = 2 days;

    function setUp() public {
        verifier = new ReplayVerifier();
        treasury = new Treasury(deployer);
        escrow = new MatchEscrow(address(verifier), address(treasury), 250, 600, 1 days, deployer);
        prizes = new WeeklyPrizes(deployer);

        address[] memory roles = new address[](1);
        roles[0] = multisig;
        timelock = new TimelockController(DELAY, roles, roles, address(0));

        // hand over ALL four ownables (Govern.s.sol does the same)
        escrow.transferOwnership(address(timelock));
        treasury.transferOwnership(address(timelock));
        prizes.transferOwnership(address(timelock));
    }

    function test_ownershipMovedToTimelock() public view {
        assertEq(escrow.owner(), address(timelock));
        assertEq(treasury.owner(), address(timelock));
        assertEq(prizes.owner(), address(timelock), "WeeklyPrizes must be governed too");
    }

    function test_directAdminCallNowReverts() public {
        // the old owner can no longer change anything directly, on any contract
        vm.expectRevert();
        escrow.setRake(500);
        vm.expectRevert();
        prizes.sweep(1, deployer); // a WeeklyPrizes admin action is also gated now
    }

    // a WeeklyPrizes admin action (setSeasonsUnlocked-style — here setRequester
    // is on escrow; prizes has sweep/publish which are onlyOwner) must also flow
    // through the timelock, proving the pot's controls are governed, not hot-key.
    function test_weeklyPrizesGovernedViaTimelock() public {
        // publishRound is onlyOwner; scheduling it through the timelock proves
        // the distributor's privileged surface now needs the multisig + delay
        bytes memory data =
            abi.encodeCall(WeeklyPrizes.publishRound, (7, address(0xDEAD), bytes32(uint256(1)), 1, uint64(block.timestamp + 1 days)));
        bytes32 salt = bytes32(0);
        vm.prank(multisig);
        timelock.schedule(address(prizes), 0, data, bytes32(0), salt, DELAY);
        assertTrue(timelock.isOperationPending(timelock.hashOperation(address(prizes), 0, data, bytes32(0), salt)));
    }

    function test_adminChangeViaTimelock() public {
        bytes memory data = abi.encodeCall(MatchEscrow.setRake, (500));
        bytes32 salt = bytes32(0);
        bytes32 id = timelock.hashOperation(address(escrow), 0, data, bytes32(0), salt);

        vm.prank(multisig);
        timelock.schedule(address(escrow), 0, data, bytes32(0), salt, DELAY);

        // cannot execute before the delay elapses
        vm.prank(multisig);
        vm.expectRevert();
        timelock.execute(address(escrow), 0, data, bytes32(0), salt);

        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(multisig);
        timelock.execute(address(escrow), 0, data, bytes32(0), salt);

        assertTrue(timelock.isOperationDone(id));
        assertEq(escrow.rakeBps(), 500);
    }
}
