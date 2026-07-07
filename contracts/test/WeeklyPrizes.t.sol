// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WeeklyPrizes} from "../src/WeeklyPrizes.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract WeeklyPrizesTest is Test {
    WeeklyPrizes internal dist;
    MockERC20 internal usdc; // 6-dec

    address internal owner = address(0x0E1);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0);
    address internal carol = address(0xCA);

    uint256 internal constant ROUND = 202627; // "2026-W27"
    uint64 internal reclaimAfter;

    function setUp() public {
        dist = new WeeklyPrizes(owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        reclaimAfter = uint64(block.timestamp + 30 days);
        usdc.mint(owner, 1_000_000e6);
        vm.prank(owner);
        usdc.approve(address(dist), type(uint256).max);
    }

    // ------------------------------ helpers ----------------------------- //

    function _leaf(address a, uint256 amt) internal pure returns (bytes32) {
        return keccak256(abi.encode(a, amt));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _publish(uint256 round, bytes32 root, uint256 amount) internal {
        vm.prank(owner);
        dist.publishRound(round, address(usdc), root, amount, reclaimAfter);
    }

    // ------------------------------ publish ----------------------------- //

    function test_publish_pullsFundsAndSealsRoot() public {
        bytes32 root = _leaf(alice, 20e6); // single-leaf tree
        _publish(ROUND, root, 20e6);

        (address token, bytes32 mr, uint128 funded, uint128 claimed_, uint64 ra) = dist.rounds(ROUND);
        assertEq(token, address(usdc));
        assertEq(mr, root);
        assertEq(funded, 20e6);
        assertEq(claimed_, 0);
        assertEq(ra, reclaimAfter);
        assertEq(usdc.balanceOf(address(dist)), 20e6, "pot is held by the contract, not the server");
    }

    function test_publish_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        dist.publishRound(ROUND, address(usdc), _leaf(alice, 1e6), 1e6, reclaimAfter);
    }

    function test_publish_revertRoundExists() public {
        _publish(ROUND, _leaf(alice, 20e6), 20e6);
        vm.prank(owner);
        vm.expectRevert(bytes("WeeklyPrizes: round exists"));
        dist.publishRound(ROUND, address(usdc), _leaf(bob, 5e6), 5e6, reclaimAfter);
    }

    function test_publish_revertEmptyRoot() public {
        vm.prank(owner);
        vm.expectRevert(bytes("WeeklyPrizes: empty root"));
        dist.publishRound(ROUND, address(usdc), bytes32(0), 20e6, reclaimAfter);
    }

    // ------------------------------- claim ------------------------------ //

    function test_claim_twoWinners_paidFromContract() public {
        uint256 prizeA = 20e6;
        uint256 prizeB = 10e6;
        bytes32 la = _leaf(alice, prizeA);
        bytes32 lb = _leaf(bob, prizeB);
        bytes32 root = _hashPair(la, lb);
        _publish(ROUND, root, prizeA + prizeB);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = lb;
        bytes32[] memory proofB = new bytes32[](1);
        proofB[0] = la;

        vm.prank(alice);
        dist.claim(ROUND, prizeA, proofA);
        assertEq(usdc.balanceOf(alice), prizeA);

        vm.prank(bob);
        dist.claim(ROUND, prizeB, proofB);
        assertEq(usdc.balanceOf(bob), prizeB);

        (,, uint128 funded, uint128 claimed_,) = dist.rounds(ROUND);
        assertEq(claimed_, funded, "round fully claimed");
        assertEq(usdc.balanceOf(address(dist)), 0);
    }

    function test_claim_revertDoubleClaim() public {
        bytes32 root = _leaf(alice, 20e6);
        _publish(ROUND, root, 20e6);
        bytes32[] memory empty = new bytes32[](0);

        vm.prank(alice);
        dist.claim(ROUND, 20e6, empty);
        vm.prank(alice);
        vm.expectRevert(bytes("WeeklyPrizes: already claimed"));
        dist.claim(ROUND, 20e6, empty);
    }

    function test_claim_revertBadProof() public {
        bytes32 root = _leaf(alice, 20e6);
        _publish(ROUND, root, 20e6);
        // bob has no leaf in a single-alice tree
        bytes32[] memory empty = new bytes32[](0);
        vm.prank(bob);
        vm.expectRevert(bytes("WeeklyPrizes: bad proof"));
        dist.claim(ROUND, 20e6, empty);
    }

    // the leaf binds the account: a third party cannot claim someone else's
    // prize even with the right amount, because msg.sender feeds the leaf.
    function test_claim_onlyWinnerCanClaim() public {
        bytes32 root = _leaf(alice, 20e6);
        _publish(ROUND, root, 20e6);
        bytes32[] memory empty = new bytes32[](0);
        vm.prank(carol); // not alice
        vm.expectRevert(bytes("WeeklyPrizes: bad proof"));
        dist.claim(ROUND, 20e6, empty);
    }

    function test_claim_revertNoRound() public {
        bytes32[] memory empty = new bytes32[](0);
        vm.prank(alice);
        vm.expectRevert(bytes("WeeklyPrizes: no round"));
        dist.claim(999, 1e6, empty);
    }

    // a malformed/greedy root that allocates more than was funded can never pay
    // beyond the round's funding — the solvency guard stops it.
    function test_claim_revertExceedsFunding() public {
        uint256 greedy = 50e6;
        bytes32 root = _leaf(alice, greedy); // root promises 50…
        _publish(ROUND, root, 20e6); // …but only 20 was funded
        bytes32[] memory empty = new bytes32[](0);
        vm.prank(alice);
        vm.expectRevert(bytes("WeeklyPrizes: exceeds funding"));
        dist.claim(ROUND, greedy, empty);
    }

    // PER-ROUND solvency: an over-allocated round A cannot reach into round B's
    // funds sitting in the same contract.
    function test_claim_roundCannotDrainAnotherRound() public {
        // round A funded 20, but its root greedily promises alice 60
        _publish(1, _leaf(alice, 60e6), 20e6);
        // round B funded 40 for bob — sits in the same contract balance
        _publish(2, _leaf(bob, 40e6), 40e6);
        assertEq(usdc.balanceOf(address(dist)), 60e6);

        bytes32[] memory empty = new bytes32[](0);
        // alice tries to over-claim round A into B's money → blocked at A's ceiling
        vm.prank(alice);
        vm.expectRevert(bytes("WeeklyPrizes: exceeds funding"));
        dist.claim(1, 60e6, empty);

        // bob still gets his full round-B prize, untouched
        vm.prank(bob);
        dist.claim(2, 40e6, empty);
        assertEq(usdc.balanceOf(bob), 40e6);
    }

    // ------------------------------- sweep ------------------------------ //

    function test_sweep_recoversUnclaimedAfterWindow() public {
        // fund 30, only alice (20) claims; 10 must be recoverable
        bytes32 la = _leaf(alice, 20e6);
        bytes32 lb = _leaf(bob, 10e6);
        bytes32 root = _hashPair(la, lb);
        _publish(ROUND, root, 30e6);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = lb;
        vm.prank(alice);
        dist.claim(ROUND, 20e6, proofA);

        vm.warp(reclaimAfter + 1);
        vm.prank(owner);
        dist.sweep(ROUND, owner);
        // the 10 bob never claimed rolls back to the owner (→ next week's pot)
        assertEq(usdc.balanceOf(address(dist)), 0);

        // and the round is closed: bob can no longer claim
        bytes32[] memory proofB = new bytes32[](1);
        proofB[0] = la;
        vm.prank(bob);
        vm.expectRevert(bytes("WeeklyPrizes: exceeds funding"));
        dist.claim(ROUND, 10e6, proofB);
    }

    function test_sweep_revertBeforeWindow() public {
        _publish(ROUND, _leaf(alice, 20e6), 20e6);
        vm.prank(owner);
        vm.expectRevert(bytes("WeeklyPrizes: window open"));
        dist.sweep(ROUND, owner);
    }

    function test_sweep_onlyOwner() public {
        _publish(ROUND, _leaf(alice, 20e6), 20e6);
        vm.warp(reclaimAfter + 1);
        vm.prank(alice);
        vm.expectRevert();
        dist.sweep(ROUND, alice);
    }

    function test_sweep_revertNothingLeft() public {
        _publish(ROUND, _leaf(alice, 20e6), 20e6);
        bytes32[] memory empty = new bytes32[](0);
        vm.prank(alice);
        dist.claim(ROUND, 20e6, empty);
        vm.warp(reclaimAfter + 1);
        vm.prank(owner);
        vm.expectRevert(bytes("WeeklyPrizes: nothing to sweep"));
        dist.sweep(ROUND, owner);
    }
}
