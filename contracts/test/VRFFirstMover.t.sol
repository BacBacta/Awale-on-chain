// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VRFFirstMover, IVRFCoordinatorV2Plus} from "../src/VRFFirstMover.sol";

/// @dev Minimal VRF coordinator mock: hands back an incrementing requestId and
///      lets the test drive the fulfilment callback with a chosen random word.
contract MockVRFCoordinator is IVRFCoordinatorV2Plus {
    uint256 public nextId = 1;
    VRFFirstMover public consumer;

    function setConsumer(VRFFirstMover c) external {
        consumer = c;
    }

    function requestRandomWords(RandomWordsRequest calldata) external returns (uint256) {
        return nextId++;
    }

    /// test helper: simulate the VRF network fulfilling `requestId`
    function fulfill(uint256 requestId, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        consumer.rawFulfillRandomWords(requestId, words);
    }
}

contract VRFFirstMoverTest is Test {
    MockVRFCoordinator internal coord;
    VRFFirstMover internal vrf;
    address internal owner = address(0x0E1);
    address internal keeper = address(0xBEEF);

    function setUp() public {
        coord = new MockVRFCoordinator();
        vrf = new VRFFirstMover(address(coord), keccak256("gaslane"), 42, owner);
        coord.setConsumer(vrf);
        vm.prank(owner);
        vrf.setRequester(keeper, true);
    }

    function test_request_thenFulfill_fixesFirstMover() public {
        vm.prank(keeper);
        uint256 reqId = vrf.requestFirstMover(1);
        assertFalse(vrf.isFixed(1), "not fixed before fulfilment");

        coord.fulfill(reqId, 12345); // odd → start 1
        assertTrue(vrf.isFixed(1));
        assertEq(vrf.firstMover(1), 1);
    }

    function test_evenWordGivesStartZero() public {
        vm.prank(keeper);
        uint256 reqId = vrf.requestFirstMover(7);
        coord.fulfill(reqId, 1000); // even → start 0
        assertEq(vrf.firstMover(7), 0);
    }

    function test_onlyRequesterCanRequest() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(VRFFirstMover.NotRequester.selector);
        vrf.requestFirstMover(1);
    }

    function test_oneRequestPerMatch() public {
        vm.startPrank(keeper);
        vrf.requestFirstMover(1);
        vm.expectRevert(VRFFirstMover.AlreadyRequested.selector);
        vrf.requestFirstMover(1);
        vm.stopPrank();
    }

    function test_onlyCoordinatorCanFulfill() public {
        vm.prank(keeper);
        vrf.requestFirstMover(1);
        uint256[] memory words = new uint256[](1);
        words[0] = 5;
        vm.prank(address(0xBAD));
        vm.expectRevert(VRFFirstMover.NotCoordinator.selector);
        vrf.rawFulfillRandomWords(1, words);
    }

    function test_firstMoverRevertsUntilFixed() public {
        vm.prank(keeper);
        vrf.requestFirstMover(1);
        vm.expectRevert(VRFFirstMover.NotFixed.selector);
        vrf.firstMover(1);
    }

    function test_duplicateFulfilmentIsIgnored() public {
        vm.prank(keeper);
        uint256 reqId = vrf.requestFirstMover(1);
        coord.fulfill(reqId, 1); // start 1
        coord.fulfill(reqId, 2); // even, but ignored — already fixed
        assertEq(vrf.firstMover(1), 1, "first fulfilment wins, no re-roll");
    }
}
