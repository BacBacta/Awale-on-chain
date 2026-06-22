// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TournamentEscrow} from "../src/TournamentEscrow.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract TournamentEscrowTest is Test {
    TournamentEscrow internal tourney;
    MockERC20 internal usdc; // 6-dec stablecoin

    address internal owner = address(0x0E1);
    address internal treasury = address(0x7EA);
    address internal operator = address(0x09E);
    address internal sponsor = address(0x5907);

    uint16 internal constant CUT_BPS = 800; // 8%
    uint128 internal constant FEE = 1_000_000; // 1 USDC (6 decimals)
    uint64 internal constant JOIN_WINDOW = 1 hours;
    uint64 internal constant REFUND_WINDOW = 1 days;

    address[] internal players;

    function setUp() public {
        tourney = new TournamentEscrow(treasury, operator, owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        vm.prank(owner);
        tourney.setTokenAllowed(address(usdc), true);

        for (uint160 i = 1; i <= 8; i++) {
            address p = address(0x1000 + i);
            players.push(p);
            usdc.mint(p, 1_000_000_000);
            vm.prank(p);
            usdc.approve(address(tourney), type(uint256).max);
        }
        usdc.mint(sponsor, 1_000_000_000);
        vm.prank(sponsor);
        usdc.approve(address(tourney), type(uint256).max);
    }

    function _payout6535() internal pure returns (uint16[] memory p) {
        p = new uint16[](2);
        p[0] = 6500;
        p[1] = 3500;
    }

    function _createSNG8() internal returns (uint256 id) {
        vm.prank(operator);
        id = tourney.createTournament(address(usdc), FEE, 8, CUT_BPS, JOIN_WINDOW, REFUND_WINDOW, _payout6535());
    }

    function _fill(uint256 id, uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            vm.prank(players[i]);
            tourney.join(id);
        }
    }

    // ------------------------- happy path -------------------------------- //

    function test_full_sng_pays_table_and_cut() public {
        uint256 id = _createSNG8();
        _fill(id, 8);

        // pool = 8 USDC; cut 8% = 0.64; distributable = 7.36; 1st 65% = 4.784, 2nd 35% = 2.576
        address[] memory winners = new address[](2);
        winners[0] = players[3];
        winners[1] = players[5];

        uint256 treBefore = usdc.balanceOf(treasury);
        vm.prank(operator);
        tourney.finalize(id, winners);

        assertEq(usdc.balanceOf(players[3]), 1_000_000_000 - FEE + 4_784_000, "1st prize");
        assertEq(usdc.balanceOf(players[5]), 1_000_000_000 - FEE + 2_576_000, "2nd prize");
        assertEq(usdc.balanceOf(treasury) - treBefore, 640_000, "cut to treasury");
        assertEq(usdc.balanceOf(address(tourney)), 0, "escrow drained");

        TournamentEscrow.Tournament memory t = tourney.getTournament(id);
        assertEq(uint8(t.status), uint8(TournamentEscrow.Status.Finalized));
    }

    function test_prizeBreakdown_matches_payout() public {
        uint256 id = _createSNG8();
        _fill(id, 8);
        (uint256 pool, uint256 cut, uint256[] memory prizes) = tourney.prizeBreakdown(id);
        assertEq(pool, 8 * FEE);
        assertEq(cut, 640_000);
        assertEq(prizes[0], 4_784_000);
        assertEq(prizes[1], 2_576_000);
    }

    // ------------------------- free-roll --------------------------------- //

    function test_freeroll_sponsored_pool() public {
        uint16[] memory winnerTakeAll = new uint16[](1);
        winnerTakeAll[0] = 10_000;
        vm.prank(operator);
        uint256 id = tourney.createTournament(address(usdc), 0, 8, 0, JOIN_WINDOW, REFUND_WINDOW, winnerTakeAll);

        vm.prank(sponsor);
        tourney.fund(id, 5_000_000); // 5 USDC sponsored prize
        _fill(id, 4); // free entries

        address[] memory winners = new address[](1);
        winners[0] = players[2];
        vm.prank(operator);
        tourney.finalize(id, winners);

        assertEq(usdc.balanceOf(players[2]), 1_000_000_000 + 5_000_000, "winner takes sponsored pool, no fee paid");
        assertEq(usdc.balanceOf(treasury), 0, "no cut on a 0-cut freeroll");
    }

    // ------------------------- refunds ----------------------------------- //

    function test_refund_when_underfilled() public {
        uint256 id = _createSNG8();
        _fill(id, 1); // only one entrant

        vm.warp(block.timestamp + JOIN_WINDOW + 1);
        tourney.refund(id); // permissionless

        assertEq(usdc.balanceOf(players[0]), 1_000_000_000, "entry fee returned");
        TournamentEscrow.Tournament memory t = tourney.getTournament(id);
        assertEq(uint8(t.status), uint8(TournamentEscrow.Status.Cancelled));
    }

    function test_refund_when_operator_never_finalizes() public {
        uint256 id = _createSNG8();
        _fill(id, 8);

        vm.warp(block.timestamp + REFUND_WINDOW + 1);
        tourney.refund(id);
        for (uint256 i = 0; i < 8; i++) {
            assertEq(usdc.balanceOf(players[i]), 1_000_000_000, "all entrants refunded");
        }
    }

    function test_refund_sweeps_sponsor_funds_to_treasury() public {
        uint256 id = _createSNG8();
        vm.prank(sponsor);
        tourney.fund(id, 3_000_000);
        _fill(id, 1);

        vm.warp(block.timestamp + JOIN_WINDOW + 1);
        tourney.refund(id);
        assertEq(usdc.balanceOf(players[0]), 1_000_000_000, "entrant refunded fee");
        assertEq(usdc.balanceOf(treasury), 3_000_000, "sponsor money swept to treasury");
    }

    // ------------------------- guards ------------------------------------ //

    function test_only_operator_creates_and_finalizes() public {
        vm.prank(players[0]);
        vm.expectRevert("Tournament: not operator");
        tourney.createTournament(address(usdc), FEE, 8, CUT_BPS, JOIN_WINDOW, REFUND_WINDOW, _payout6535());

        uint256 id = _createSNG8();
        _fill(id, 8);
        address[] memory winners = new address[](1);
        winners[0] = players[0];
        vm.prank(players[0]);
        vm.expectRevert("Tournament: not operator");
        tourney.finalize(id, winners);
    }

    function test_cannot_pay_a_nonentrant() public {
        uint256 id = _createSNG8();
        _fill(id, 8);
        address[] memory winners = new address[](2);
        winners[0] = players[0];
        winners[1] = address(0xDEAD); // never joined
        vm.prank(operator);
        vm.expectRevert("Tournament: winner not entrant");
        tourney.finalize(id, winners);
    }

    function test_rejects_duplicate_winner() public {
        uint256 id = _createSNG8();
        _fill(id, 8);
        address[] memory winners = new address[](2);
        winners[0] = players[0];
        winners[1] = players[0];
        vm.prank(operator);
        vm.expectRevert("Tournament: duplicate winner");
        tourney.finalize(id, winners);
    }

    function test_cannot_double_join() public {
        uint256 id = _createSNG8();
        vm.prank(players[0]);
        tourney.join(id);
        vm.prank(players[0]);
        vm.expectRevert("Tournament: already joined");
        tourney.join(id);
    }

    function test_cannot_join_after_deadline() public {
        uint256 id = _createSNG8();
        vm.warp(block.timestamp + JOIN_WINDOW + 1);
        vm.prank(players[0]);
        vm.expectRevert("Tournament: entries closed");
        tourney.join(id);
    }

    function test_cannot_finalize_underfilled() public {
        uint256 id = _createSNG8();
        _fill(id, 1);
        address[] memory winners = new address[](1);
        winners[0] = players[0];
        vm.prank(operator);
        vm.expectRevert("Tournament: under-filled");
        tourney.finalize(id, winners);
    }

    function test_payout_table_must_sum_to_100pct() public {
        uint16[] memory bad = new uint16[](2);
        bad[0] = 6000;
        bad[1] = 3000; // sums to 9000, not 10000
        vm.prank(operator);
        vm.expectRevert("Tournament: payout != 100%");
        tourney.createTournament(address(usdc), FEE, 8, CUT_BPS, JOIN_WINDOW, REFUND_WINDOW, bad);
    }

    function test_cut_capped() public {
        vm.prank(operator);
        vm.expectRevert("Tournament: cut too high");
        tourney.createTournament(address(usdc), FEE, 8, 2001, JOIN_WINDOW, REFUND_WINDOW, _payout6535());
    }

    function test_unfilled_places_sweep_to_treasury() public {
        // 3-place table but only 2 players ⇒ 3rd share goes to treasury
        uint16[] memory three = new uint16[](3);
        three[0] = 5000;
        three[1] = 3000;
        three[2] = 2000;
        vm.prank(operator);
        uint256 id = tourney.createTournament(address(usdc), FEE, 8, 0, JOIN_WINDOW, REFUND_WINDOW, three);
        _fill(id, 2);

        address[] memory winners = new address[](2);
        winners[0] = players[0];
        winners[1] = players[1];
        vm.prank(operator);
        tourney.finalize(id, winners);

        // pool 2 USDC, no cut; 1st 50% = 1.0, 2nd 30% = 0.6, 3rd 20% = 0.4 unfilled → treasury
        assertEq(usdc.balanceOf(players[0]), 1_000_000_000 - FEE + 1_000_000);
        assertEq(usdc.balanceOf(players[1]), 1_000_000_000 - FEE + 600_000);
        assertEq(usdc.balanceOf(treasury), 400_000, "unfilled 3rd place to treasury");
    }
}
