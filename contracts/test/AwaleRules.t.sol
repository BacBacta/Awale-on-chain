// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AwaleRules} from "../src/AwaleRules.sol";

/// @dev External wrapper so `vm.expectRevert` can catch reverts raised inside
///      the (otherwise inlined) library functions.
contract AwaleHarness {
    function apply_(AwaleRules.GameState memory s, uint8 h)
        external
        pure
        returns (AwaleRules.GameState memory)
    {
        return AwaleRules.applyMove(s, h);
    }

    function mask(AwaleRules.GameState memory s) external pure returns (uint8) {
        return AwaleRules.legalMovesMask(s);
    }
}

contract AwaleRulesTest is Test {
    AwaleHarness internal h;

    function setUp() public {
        h = new AwaleHarness();
    }

    // ----------------------------- helpers ------------------------------ //

    function _board(uint8[12] memory pits, uint8 store0, uint8 store1, uint8 turn)
        internal
        pure
        returns (AwaleRules.GameState memory s)
    {
        s.pits = pits;
        s.store0 = store0;
        s.store1 = store1;
        s.turn = turn;
    }

    function _total(AwaleRules.GameState memory s) internal pure returns (uint256 t) {
        for (uint8 i = 0; i < 12; i++) {
            t += s.pits[i];
        }
        t += s.store0;
        t += s.store1;
    }

    // ----------------------------- opening ------------------------------ //

    function test_initialState() public pure {
        AwaleRules.GameState memory s = AwaleRules.initialState();
        for (uint8 i = 0; i < 12; i++) {
            assertEq(s.pits[i], 4, "every house starts with 4 seeds");
        }
        assertEq(s.store0, 0);
        assertEq(s.store1, 0);
        assertEq(s.turn, 0);
        assertFalse(s.over);
    }

    function test_initial_allSixMovesLegal() public view {
        AwaleRules.GameState memory s = AwaleRules.initialState();
        assertEq(h.mask(s), 0x3F, "all six houses legal at the opening");
    }

    // ----------------------------- sowing ------------------------------- //

    function test_simpleSow_noCapture() public view {
        // player 0 plays house 2 (4 seeds) -> 3,4,5,6
        AwaleRules.GameState memory s = AwaleRules.initialState();
        AwaleRules.GameState memory r = h.apply_(s, 2);
        assertEq(r.pits[2], 0, "origin emptied");
        assertEq(r.pits[3], 5);
        assertEq(r.pits[4], 5);
        assertEq(r.pits[5], 5);
        assertEq(r.pits[6], 5, "landed in opponent pit -> 5, not 2/3, no capture");
        assertEq(r.store0, 0);
        assertEq(r.turn, 1);
        assertEq(_total(r), 48, "seed conservation");
    }

    function test_skipOriginOnFullLap() public view {
        // 12 seeds from house 0: fills 1..11 then skips origin and adds 12th to house 1
        uint8[12] memory pits;
        pits[0] = 12;
        // give both sides residual seeds so the game does not terminate on resolve
        AwaleRules.GameState memory s = _board(pits, 0, 0, 0);
        AwaleRules.GameState memory r = h.apply_(s, 0);
        assertEq(r.pits[0], 0, "origin skipped on the lap, ends empty");
        assertEq(r.pits[1], 2, "house 1 receives two seeds (first + wrapped)");
        for (uint8 i = 2; i < 12; i++) {
            assertEq(r.pits[i], 1, "every other house receives exactly one");
        }
        assertEq(_total(r), 12);
    }

    // ----------------------------- capture ------------------------------ //

    function test_singleCapture() public view {
        // player 0 plays house 5 (1 seed) -> opponent house 6 (1 -> 2): capture 2
        uint8[12] memory pits;
        pits[0] = 4; // keep player 0 alive
        pits[5] = 1;
        pits[6] = 1;
        pits[7] = 4; // extra opponent seeds so this is not a grand slam
        AwaleRules.GameState memory r = h.apply_(_board(pits, 0, 0, 0), 5);
        assertEq(r.store0, 2, "captured the 2 seeds");
        assertEq(r.pits[6], 0, "captured house emptied");
        assertEq(r.pits[5], 0, "origin emptied");
        assertFalse(r.over);
        assertEq(_total(r), 10);
    }

    function test_multiCaptureBackwards() public view {
        // player 0 plays house 5 (2 seeds) -> 6 (1->2), 7 (1->2); capture 7 then 6 = 4
        uint8[12] memory pits;
        pits[0] = 4; // player 0 alive
        pits[5] = 2;
        pits[6] = 1;
        pits[7] = 1;
        pits[8] = 4; // opponent keeps seeds -> not a grand slam
        AwaleRules.GameState memory r = h.apply_(_board(pits, 0, 0, 0), 5);
        assertEq(r.store0, 4, "captured 2 + 2 walking backwards");
        assertEq(r.pits[7], 0);
        assertEq(r.pits[6], 0);
        assertEq(r.pits[8], 4, "non-2/3 house stops the chain, untouched");
        assertEq(_total(r), 12);
    }

    function test_grandSlam_capturesNothing() public view {
        // same as multi-capture but opponent has NO other seeds:
        // capturing 6 & 7 would empty the whole opponent row -> grand slam -> no capture
        uint8[12] memory pits;
        pits[0] = 4; // player 0 alive
        pits[5] = 2;
        pits[6] = 1;
        pits[7] = 1;
        AwaleRules.GameState memory r = h.apply_(_board(pits, 0, 0, 0), 5);
        assertEq(r.store0, 0, "grand slam captures nothing");
        assertEq(r.pits[6], 2, "seeds remain on the board");
        assertEq(r.pits[7], 2);
        assertEq(_total(r), 8);
    }

    function test_noCaptureInOwnRow() public view {
        // last seed landing in the mover's own row never captures
        uint8[12] memory pits;
        pits[0] = 1; // -> lands house 1 (own), even though it becomes 2... wait set up below
        pits[1] = 2; // becomes 3 after sow, but it is player 0's own house
        pits[6] = 4; // opponent alive
        AwaleRules.GameState memory r = h.apply_(_board(pits, 0, 0, 0), 0);
        assertEq(r.pits[1], 3, "own house reaching 3 is not captured");
        assertEq(r.store0, 0);
    }

    // ------------------------- feeding obligation ----------------------- //

    function test_mustFeed_revertsOnNonFeedingMove() public {
        // opponent (player 1) empty; house 0 stays in own row -> illegal
        uint8[12] memory pits;
        pits[0] = 1;
        pits[5] = 1;
        AwaleRules.GameState memory s = _board(pits, 0, 0, 0);
        vm.expectRevert(bytes("AwaleRules: must feed opponent"));
        h.apply_(s, 0);
    }

    function test_mustFeed_feedingMoveSucceeds() public view {
        // same position; house 5 reaches house 6 -> legal
        uint8[12] memory pits;
        pits[0] = 1;
        pits[5] = 1;
        AwaleRules.GameState memory r = h.apply_(_board(pits, 0, 0, 0), 5);
        assertEq(r.pits[6], 1, "opponent fed");
        assertFalse(r.over);
        // only the feeding move is in the legal mask
        AwaleRules.GameState memory s = _board(pits, 0, 0, 0);
        assertEq(h.mask(s), uint8(1) << 5, "only the feeding house is legal");
    }

    // ----------------------------- terminal ----------------------------- //

    function test_winBy25() public view {
        uint8[12] memory pits;
        pits[0] = 4; // player 0 alive
        pits[5] = 1;
        pits[6] = 1;
        pits[7] = 4; // not a grand slam
        AwaleRules.GameState memory r = h.apply_(_board(pits, 24, 0, 0), 5);
        assertTrue(r.over, "game ends once a store passes 24");
        assertEq(r.winner, 0);
        assertEq(r.store0, 26);
    }

    function test_drawByCollection() public view {
        // player 0 plays its last seed (house 5) into house 6 -> grand slam, no capture;
        // player 0 row now empty, player 1 cannot feed -> player 1 collects its 2 seeds.
        // 24 + 24 -> draw.
        uint8[12] memory pits;
        pits[5] = 1;
        pits[6] = 1;
        AwaleRules.GameState memory r = h.apply_(_board(pits, 24, 22, 0), 5);
        assertTrue(r.over);
        assertEq(r.winner, AwaleRules.DRAW, "24-24 is a draw");
        assertEq(r.store0, 24);
        assertEq(r.store1, 24);
        assertEq(_total(r), 48);
    }

    // ------------------------- illegal-move guards ---------------------- //

    function test_revertEmptyHouse() public {
        AwaleRules.GameState memory s = AwaleRules.initialState();
        // empty house 0 first by playing it, then try to replay it
        uint8[12] memory pits;
        pits[1] = 4;
        pits[6] = 4;
        AwaleRules.GameState memory s2 = _board(pits, 0, 0, 0);
        vm.expectRevert(bytes("AwaleRules: empty house"));
        h.apply_(s2, 0);
        s; // silence unused
    }

    function test_revertBadHouse() public {
        AwaleRules.GameState memory s = AwaleRules.initialState();
        vm.expectRevert(bytes("AwaleRules: bad house"));
        h.apply_(s, 6);
    }

    function test_revertWhenOver() public {
        AwaleRules.GameState memory s = AwaleRules.initialState();
        s.over = true;
        vm.expectRevert(bytes("AwaleRules: game over"));
        h.apply_(s, 0);
    }

    // ------------------------- invariant: conservation ------------------ //

    function test_selfPlay_conservesSeeds() public view {
        // deterministic self-play picking the lowest legal house each turn
        AwaleRules.GameState memory s = AwaleRules.initialState();
        for (uint256 ply = 0; ply < 5000 && !s.over; ply++) {
            uint8 m = h.mask(s);
            assertGt(m, 0, "non-terminal state must have a legal move");
            uint8 house = _lowestSetBit(m);
            s = h.apply_(s, house);
            assertEq(_total(s), 48, "seeds are conserved every ply");
        }
    }

    function testFuzz_conservesSeeds(uint256 seed) public view {
        AwaleRules.GameState memory s = AwaleRules.initialState();
        for (uint256 ply = 0; ply < 400 && !s.over; ply++) {
            uint8 m = h.mask(s);
            assertGt(m, 0);
            uint8 house = _nthSetBit(m, uint8(seed % 6));
            seed = uint256(keccak256(abi.encode(seed)));
            s = h.apply_(s, house);
            assertEq(_total(s), 48, "seeds are conserved under random play");
            assertLe(s.store0, 48);
            assertLe(s.store1, 48);
        }
    }

    function _lowestSetBit(uint8 m) internal pure returns (uint8) {
        for (uint8 b = 0; b < 6; b++) {
            if (m & (uint8(1) << b) != 0) return b;
        }
        revert("no legal move");
    }

    // pick the (k mod popcount)-th legal house
    function _nthSetBit(uint8 m, uint8 k) internal pure returns (uint8) {
        uint8 count = 0;
        for (uint8 b = 0; b < 6; b++) {
            if (m & (uint8(1) << b) != 0) count++;
        }
        uint8 target = k % count;
        uint8 seen = 0;
        for (uint8 b = 0; b < 6; b++) {
            if (m & (uint8(1) << b) != 0) {
                if (seen == target) return b;
                seen++;
            }
        }
        revert("unreachable");
    }
}
