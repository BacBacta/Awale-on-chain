// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReplayVerifier} from "../src/ReplayVerifier.sol";
import {AwaleRules} from "../src/AwaleRules.sol";

contract ReplayVerifierTest is Test {
    ReplayVerifier internal verifier;

    uint256 internal pk0 = 0xA11CE;
    uint256 internal pk1 = 0xB0B;
    address internal session0;
    address internal session1;

    // scratch storage used while assembling a transcript
    uint8[] internal _moves;
    bytes[] internal _sigs;

    function setUp() public {
        verifier = new ReplayVerifier();
        session0 = vm.addr(pk0);
        session1 = vm.addr(pk1);
    }

    // ------------------------------ helpers ----------------------------- //

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Self-play from the opening, choosing the lowest legal house each ply,
    ///      signing every move with the correct player's session key.
    function _build(uint256 matchId, uint8 startTurn, uint256 maxPlies)
        internal
        returns (ReplayVerifier.Transcript memory t, AwaleRules.GameState memory finalState)
    {
        delete _moves;
        delete _sigs;

        AwaleRules.GameState memory s = AwaleRules.initialState();
        s.turn = startTurn;

        for (uint256 ply = 0; ply < maxPlies && !s.over; ply++) {
            uint8 mask = AwaleRules.legalMovesMask(s);
            require(mask != 0, "no legal move");
            uint8 house = _lowest(mask);
            uint256 pk = s.turn == 0 ? pk0 : pk1;
            _moves.push(house);
            _sigs.push(_sign(pk, verifier.moveDigest(matchId, ply, house)));
            s = AwaleRules.applyMove(s, house);
        }

        t.matchId = matchId;
        t.session0 = session0;
        t.session1 = session1;
        t.startTurn = startTurn;
        t.moves = _moves;
        t.sigs = _sigs;
        finalState = s;
    }

    function _lowest(uint8 mask) internal pure returns (uint8) {
        for (uint8 b = 0; b < 6; b++) {
            if (mask & (uint8(1) << b) != 0) return b;
        }
        revert("no bit");
    }

    // ------------------------------- tests ------------------------------ //

    function test_verify_validShortTranscript() public {
        (ReplayVerifier.Transcript memory t, AwaleRules.GameState memory expected) = _build(1, 0, 8);
        AwaleRules.GameState memory got = verifier.verify(t);
        assertEq(got.store0, expected.store0);
        assertEq(got.store1, expected.store1);
        assertEq(got.turn, expected.turn);
        for (uint8 i = 0; i < 12; i++) {
            assertEq(got.pits[i], expected.pits[i], "pit mismatch vs engine");
        }
    }

    function test_verify_fullGameOutcomeMatchesEngine() public {
        (ReplayVerifier.Transcript memory t, AwaleRules.GameState memory expected) = _build(7, 0, 5000);
        assertTrue(expected.over, "self-play should terminate");
        AwaleRules.GameState memory got = verifier.verify(t);
        assertTrue(got.over);
        assertEq(got.winner, expected.winner, "verifier agrees with engine on the winner");
        assertEq(got.store0, expected.store0);
        assertEq(got.store1, expected.store1);
    }

    function test_verify_startTurnOne() public {
        (ReplayVerifier.Transcript memory t, AwaleRules.GameState memory expected) = _build(2, 1, 6);
        AwaleRules.GameState memory got = verifier.verify(t);
        assertEq(got.store1, expected.store1);
        assertEq(got.turn, expected.turn);
    }

    function test_revert_badStartTurn() public {
        (ReplayVerifier.Transcript memory t,) = _build(1, 0, 2);
        t.startTurn = 2;
        vm.expectRevert(bytes("ReplayVerifier: bad startTurn"));
        verifier.verify(t);
    }

    function test_revert_lengthMismatch() public {
        (ReplayVerifier.Transcript memory t,) = _build(1, 0, 4);
        // drop one signature
        bytes[] memory short = new bytes[](t.sigs.length - 1);
        for (uint256 i = 0; i < short.length; i++) {
            short[i] = t.sigs[i];
        }
        t.sigs = short;
        vm.expectRevert(bytes("ReplayVerifier: length mismatch"));
        verifier.verify(t);
    }

    function test_revert_tamperedSignature() public {
        (ReplayVerifier.Transcript memory t,) = _build(1, 0, 4);
        // re-sign ply 2 over a *different* house than the one recorded
        t.sigs[2] = _sign(pk0, verifier.moveDigest(1, 2, 5));
        vm.expectRevert(bytes("ReplayVerifier: bad move signature"));
        verifier.verify(t);
    }

    function test_revert_wrongSigner() public {
        (ReplayVerifier.Transcript memory t,) = _build(1, 0, 4);
        // ply 0 belongs to player 0; sign it with player 1's key instead
        t.sigs[0] = _sign(pk1, verifier.moveDigest(1, 0, t.moves[0]));
        vm.expectRevert(bytes("ReplayVerifier: bad move signature"));
        verifier.verify(t);
    }

    function test_revert_crossMatchReplay() public {
        // a transcript signed for match 1 must not verify under match 2
        (ReplayVerifier.Transcript memory t,) = _build(1, 0, 4);
        t.matchId = 2;
        vm.expectRevert(bytes("ReplayVerifier: bad move signature"));
        verifier.verify(t);
    }

    function test_revert_moveAfterGameOver() public {
        (ReplayVerifier.Transcript memory t,) = _build(9, 0, 5000);
        uint256 n = t.moves.length;
        // append one extra, correctly-signed move past the end of the game
        uint8[] memory m2 = new uint8[](n + 1);
        bytes[] memory s2 = new bytes[](n + 1);
        for (uint256 i = 0; i < n; i++) {
            m2[i] = t.moves[i];
            s2[i] = t.sigs[i];
        }
        m2[n] = 0;
        // whoever is "to move" after the game ends — sign with that turn's key.
        // Either key fails the same way (game is over); use player 0's.
        s2[n] = _sign(pk0, verifier.moveDigest(9, n, 0));
        t.moves = m2;
        t.sigs = s2;
        vm.expectRevert(bytes("AwaleRules: game over"));
        verifier.verify(t);
    }

    function test_revert_zeroSessionKey() public {
        (ReplayVerifier.Transcript memory t,) = _build(1, 0, 2);
        t.session1 = address(0);
        vm.expectRevert(bytes("ReplayVerifier: zero session key"));
        verifier.verify(t);
    }

    function test_moveDigest_isUniquePerInput() public view {
        bytes32 a = verifier.moveDigest(1, 0, 0);
        assertTrue(a != verifier.moveDigest(2, 0, 0), "matchId changes digest");
        assertTrue(a != verifier.moveDigest(1, 1, 0), "ply changes digest");
        assertTrue(a != verifier.moveDigest(1, 0, 1), "house changes digest");
    }

    function test_domainSeparator_bindsChainAndContract() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AwaleReplayVerifier"),
                keccak256("1"),
                block.chainid,
                address(verifier)
            )
        );
        assertEq(verifier.DOMAIN_SEPARATOR(), expected);
    }
}
