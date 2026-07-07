// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WeeklyPrizes} from "../src/WeeklyPrizes.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev Random-walks many weekly rounds through publish → claim → sweep, with
///      a two-winner (alice, bob) tree per round so real Merkle proofs are
///      exercised. Money is tracked with delta-based ghosts. Proves the two
///      properties that matter: the contract never holds less than it owes
///      (conservation), and no round ever pays or sweeps beyond its funding.
contract PrizesHandler is Test {
    WeeklyPrizes public dist;
    MockERC20 public usdc;
    address public owner;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint256[] public roundIds;
    mapping(uint256 => uint256) public amtA; // published prize for alice this round
    mapping(uint256 => uint256) public amtB;
    uint256 internal nextRound = 1;

    uint256 public ghostFunded; // total received across rounds
    uint256 public ghostPaid; // total claimed out
    uint256 public ghostSwept; // total swept out

    constructor(WeeklyPrizes d, MockERC20 t, address owner_) {
        dist = d;
        usdc = t;
        owner = owner_;
        usdc.mint(owner_, 1_000_000_000e6);
        vm.prank(owner_);
        usdc.approve(address(dist), type(uint256).max);
    }

    function _leaf(address a, uint256 amt) internal pure returns (bytes32) {
        return keccak256(abi.encode(a, amt));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function idsLength() external view returns (uint256) {
        return roundIds.length;
    }

    // ------------------------------ actions ----------------------------- //

    function publish(uint256 pa, uint256 pb) external {
        if (roundIds.length >= 32) return;
        uint256 a = bound(pa, 1, 1_000_000e6);
        uint256 b = bound(pb, 1, 1_000_000e6);
        uint256 round = nextRound++;
        bytes32 root = _hashPair(_leaf(alice, a), _leaf(bob, b));

        uint256 before = usdc.balanceOf(address(dist));
        vm.prank(owner);
        dist.publishRound(round, address(usdc), root, a + b, uint64(block.timestamp + 30 days));
        ghostFunded += usdc.balanceOf(address(dist)) - before;

        roundIds.push(round);
        amtA[round] = a;
        amtB[round] = b;
    }

    function claim(uint256 seed, bool who) external {
        uint256 n = roundIds.length;
        if (n == 0) return;
        uint256 round = roundIds[seed % n];
        (address winner, uint256 amt, bytes32 sibling) = who
            ? (alice, amtA[round], _leaf(bob, amtB[round]))
            : (bob, amtB[round], _leaf(alice, amtA[round]));
        if (dist.claimed(round, winner)) return;

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        uint256 before = usdc.balanceOf(address(dist));
        vm.prank(winner);
        dist.claim(round, amt, proof);
        ghostPaid += before - usdc.balanceOf(address(dist));
    }

    function sweep(uint256 seed) external {
        uint256 n = roundIds.length;
        if (n == 0) return;
        uint256 round = roundIds[seed % n];
        (,, uint128 funded, uint128 claimed_, uint64 reclaimAfter) = dist.rounds(round);
        if (funded == claimed_) return; // nothing to sweep
        vm.warp(uint256(reclaimAfter) + 1);
        uint256 before = usdc.balanceOf(address(dist));
        vm.prank(owner);
        dist.sweep(round, owner);
        ghostSwept += before - usdc.balanceOf(address(dist));
    }

    /// Sum of what every published round still owes (funded − claimed).
    function outstanding() external view returns (uint256 total) {
        for (uint256 i; i < roundIds.length; i++) {
            (,, uint128 funded, uint128 claimed_,) = dist.rounds(roundIds[i]);
            total += uint256(funded) - claimed_;
        }
    }

    /// True if any round has ever paid/swept past its funding.
    function anyRoundOverspent() external view returns (bool) {
        for (uint256 i; i < roundIds.length; i++) {
            (,, uint128 funded, uint128 claimed_,) = dist.rounds(roundIds[i]);
            if (claimed_ > funded) return true;
        }
        return false;
    }
}

contract WeeklyPrizesInvariantTest is Test {
    WeeklyPrizes internal dist;
    MockERC20 internal usdc;
    PrizesHandler internal handler;
    address internal owner = address(0x0E1);

    function setUp() public {
        dist = new WeeklyPrizes(owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        handler = new PrizesHandler(dist, usdc, owner);
        targetContract(address(handler));
    }

    /// CONSERVATION: every token the contract received is either still held or
    /// has left as a claim or a sweep — nothing minted or lost.
    function invariant_conservation() public view {
        assertEq(handler.ghostFunded(), usdc.balanceOf(address(dist)) + handler.ghostPaid() + handler.ghostSwept(), "tokens leaked");
    }

    /// SOLVENCY: the contract always holds at least what its rounds still owe.
    function invariant_holdsWhatItOwes() public view {
        assertGe(usdc.balanceOf(address(dist)), handler.outstanding(), "cannot cover outstanding prizes");
    }

    /// No round's payouts ever exceed its funding (the per-round ceiling).
    function invariant_noRoundOverspends() public view {
        assertFalse(handler.anyRoundOverspent(), "a round paid beyond its funding");
    }
}
