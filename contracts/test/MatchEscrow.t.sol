// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MatchEscrow} from "../src/MatchEscrow.sol";
import {ReplayVerifier} from "../src/ReplayVerifier.sol";
import {AwaleRules} from "../src/AwaleRules.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract MatchEscrowTest is Test {
    MatchEscrow internal escrow;
    ReplayVerifier internal verifier;
    MockERC20 internal usdc; // 6-dec stablecoin

    address internal owner = address(0x0E1);
    address internal treasury = address(0x7EA);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0);

    uint256 internal pk0 = 0xA11CE;
    uint256 internal pk1 = 0xB0B;
    address internal session0;
    address internal session1;

    uint16 internal constant RAKE_BPS = 250; // 2.5%
    uint64 internal constant WINDOW = 600; // 10 minutes
    uint64 internal constant TTL = 1 days; // unsettled-match expiry
    uint128 internal constant STAKE = 10_000_000; // 10 USDC (6 decimals)

    uint8[] internal _moves;
    bytes[] internal _sigs;

    function setUp() public {
        verifier = new ReplayVerifier();
        escrow = new MatchEscrow(address(verifier), treasury, RAKE_BPS, WINDOW, TTL, owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);

        vm.prank(owner);
        escrow.setTokenAllowed(address(usdc), true);

        session0 = vm.addr(pk0);
        session1 = vm.addr(pk1);

        usdc.mint(alice, 1_000_000_000);
        usdc.mint(bob, 1_000_000_000);
        vm.prank(alice);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ------------------------------ helpers ----------------------------- //

    /// @dev Create, join, and finalize the first-move flip so the match is
    ///      ready to play. The flip is deferred to a future block (anti-grinding),
    ///      so advance past the reveal block and fix it before returning.
    function _createAndJoin() internal returns (uint256 matchId) {
        matchId = _createAndJoinNoFinalize();
        vm.roll(block.number + uint256(escrow.START_REVEAL_DELAY()) + 1);
        escrow.finalizeStart(matchId);
    }

    function _createAndJoinNoFinalize() internal returns (uint256 matchId) {
        vm.prank(alice);
        matchId = escrow.createMatch(address(usdc), STAKE, session0);
        vm.prank(bob);
        escrow.joinMatch(matchId, session1);
    }

    function _signResult(uint256 pk, uint256 matchId, uint8 winner) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, escrow.resultDigest(matchId, winner));
        return abi.encodePacked(r, s, v);
    }

    function _signMove(uint256 pk, uint256 matchId, uint256 ply, uint8 house) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, verifier.moveDigest(matchId, ply, house));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Build a full signed game transcript that terminates, using the
    ///      match's committed startTurn and the registered session keys.
    function _buildFullTranscript(uint256 matchId, uint8 startTurn)
        internal
        returns (ReplayVerifier.Transcript memory t, uint8 winner)
    {
        delete _moves;
        delete _sigs;
        AwaleRules.GameState memory s = AwaleRules.initialState();
        s.turn = startTurn;
        for (uint256 ply = 0; ply < 5000 && !s.over; ply++) {
            uint8 mask = AwaleRules.legalMovesMask(s);
            uint8 house = _lowest(mask);
            uint256 pk = s.turn == 0 ? pk0 : pk1;
            _moves.push(house);
            _sigs.push(_signMove(pk, matchId, ply, house));
            s = AwaleRules.applyMove(s, house);
        }
        t = ReplayVerifier.Transcript({
            matchId: matchId, session0: session0, session1: session1, startTurn: startTurn, moves: _moves, sigs: _sigs
        });
        winner = s.winner;
    }

    function _lowest(uint8 mask) internal pure returns (uint8) {
        for (uint8 b = 0; b < 6; b++) {
            if (mask & (uint8(1) << b) != 0) return b;
        }
        revert("no bit");
    }

    // ------------------------------ funding ----------------------------- //

    function test_createMatch_locksStake() public {
        vm.prank(alice);
        uint256 id = escrow.createMatch(address(usdc), STAKE, session0);
        assertEq(usdc.balanceOf(address(escrow)), STAKE);
        MatchEscrow.Match memory m = escrow.getMatch(id);
        assertEq(uint8(m.status), uint8(MatchEscrow.Status.Open));
        assertEq(m.player0, alice);
        assertEq(m.session0, session0);
    }

    function test_joinMatch_activates() public {
        uint256 id = _createAndJoinNoFinalize();
        assertEq(usdc.balanceOf(address(escrow)), uint256(STAKE) * 2);
        MatchEscrow.Match memory m = escrow.getMatch(id);
        assertEq(uint8(m.status), uint8(MatchEscrow.Status.Active));
        assertEq(m.player1, bob);
        // the first-move flip is deferred to a future block, not set at join
        assertEq(m.startTurn, type(uint8).max, "startTurn unset until finalized");
        assertGt(m.revealBlock, block.number, "reveal block is in the future");
    }

    // ----------------------- first-move randomness ---------------------- //

    function test_finalizeStart_fixesFirstMover() public {
        uint256 id = _createAndJoinNoFinalize();
        vm.roll(block.number + uint256(escrow.START_REVEAL_DELAY()) + 1);
        escrow.finalizeStart(id);
        uint8 start = escrow.getMatch(id).startTurn;
        assertLt(start, 2, "startTurn fixed to 0 or 1");
    }

    function test_finalizeStart_revertsBeforeRevealBlock() public {
        uint256 id = _createAndJoinNoFinalize();
        // still at the join block: reveal block not yet mined
        vm.expectRevert(bytes("MatchEscrow: too early"));
        escrow.finalizeStart(id);
    }

    function test_finalizeStart_revertsOnceFixed() public {
        uint256 id = _createAndJoin(); // already finalized
        vm.expectRevert(bytes("MatchEscrow: start fixed"));
        escrow.finalizeStart(id);
    }

    function test_proposeResult_revertsBeforeStartFinalized() public {
        uint256 id = _createAndJoinNoFinalize();
        vm.prank(alice);
        vm.expectRevert(bytes("MatchEscrow: start not finalized"));
        escrow.proposeResult(id, 0, bytes32(uint256(1)));
    }

    function test_cancelMatch_refunds() public {
        vm.prank(alice);
        uint256 id = escrow.createMatch(address(usdc), STAKE, session0);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        escrow.cancelMatch(id);
        assertEq(usdc.balanceOf(alice), before + STAKE);
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Cancelled));
    }

    function test_revert_selfJoin() public {
        vm.prank(alice);
        uint256 id = escrow.createMatch(address(usdc), STAKE, session0);
        vm.prank(alice);
        vm.expectRevert(bytes("MatchEscrow: self-join"));
        escrow.joinMatch(id, session1);
    }

    function test_revert_joinNotOpen() public {
        uint256 id = _createAndJoin();
        vm.prank(bob);
        vm.expectRevert(bytes("MatchEscrow: not open"));
        escrow.joinMatch(id, session1);
    }

    // --------------------------- settleSigned --------------------------- //

    function test_settleSigned_paysWinnerAndRake() public {
        uint256 id = _createAndJoin();
        uint256 pot = uint256(STAKE) * 2;
        uint256 rake = (pot * RAKE_BPS) / 10_000;
        uint256 prize = pot - rake;

        uint256 aliceBefore = usdc.balanceOf(alice);
        bytes memory s0 = _signResult(pk0, id, 0);
        bytes memory s1 = _signResult(pk1, id, 0);
        escrow.settleSigned(id, 0, s0, s1);

        assertEq(usdc.balanceOf(alice), aliceBefore + prize, "winner gets pot minus rake");
        assertEq(usdc.balanceOf(treasury), rake, "treasury gets the rake");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Resolved));
    }

    function test_settleSigned_drawSplitsNoRake() public {
        uint256 id = _createAndJoin();
        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);
        bytes memory s0 = _signResult(pk0, id, 2);
        bytes memory s1 = _signResult(pk1, id, 2);
        escrow.settleSigned(id, 2, s0, s1);

        assertEq(usdc.balanceOf(alice), aBefore + STAKE, "stake returned");
        assertEq(usdc.balanceOf(bob), bBefore + STAKE, "stake returned");
        assertEq(usdc.balanceOf(treasury), 0, "no rake on a draw");
    }

    function test_settleSigned_revertBadSig() public {
        uint256 id = _createAndJoin();
        bytes memory s0 = _signResult(pk0, id, 0);
        bytes memory wrong = _signResult(pk0, id, 0); // player1 slot signed by pk0
        vm.expectRevert(bytes("MatchEscrow: bad sig1"));
        escrow.settleSigned(id, 0, s0, wrong);
    }

    function test_settleSigned_revertWrongWinnerSigned() public {
        // both signed winner=1, but caller submits winner=0 -> digests differ -> bad sig
        uint256 id = _createAndJoin();
        bytes memory s0 = _signResult(pk0, id, 1);
        bytes memory s1 = _signResult(pk1, id, 1);
        vm.expectRevert(bytes("MatchEscrow: bad sig0"));
        escrow.settleSigned(id, 0, s0, s1);
    }

    // ----------------------- propose / finalize ------------------------- //

    function test_proposeThenFinalize_paysProposedWinner() public {
        uint256 id = _createAndJoin();
        vm.prank(alice);
        escrow.proposeResult(id, 0, bytes32(uint256(1)));

        // cannot finalize before the window elapses
        vm.expectRevert(bytes("MatchEscrow: window open"));
        escrow.finalize(id);

        vm.warp(block.timestamp + WINDOW + 1);
        uint256 aliceBefore = usdc.balanceOf(alice);
        escrow.finalize(id);

        uint256 prize = (uint256(STAKE) * 2) - (uint256(STAKE) * 2 * RAKE_BPS) / 10_000;
        assertEq(usdc.balanceOf(alice), aliceBefore + prize);
    }

    function test_proposeByNonPlayer_reverts() public {
        uint256 id = _createAndJoin();
        vm.prank(address(0xdead));
        vm.expectRevert(bytes("MatchEscrow: not a player"));
        escrow.proposeResult(id, 0, bytes32(uint256(1)));
    }

    // ------------------------------ challenge --------------------------- //

    function test_challenge_overturnsFalseProposal() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory t, uint8 trueWinner) = _buildFullTranscript(id, startTurn);

        // a liar proposes the *opposite* winner; commitment irrelevant (terminal path ignores it)
        uint8 liarClaim = trueWinner == 0 ? 1 : 0;
        vm.prank(bob);
        escrow.proposeResult(id, liarClaim, bytes32(uint256(1)));

        address trueWinnerAddr = trueWinner == 0 ? alice : bob;
        uint256 before = usdc.balanceOf(trueWinnerAddr);

        // challenger must be a match player; alice is always player0
        vm.prank(alice);
        escrow.challenge(id, t);

        uint256 prize = (uint256(STAKE) * 2) - (uint256(STAKE) * 2 * RAKE_BPS) / 10_000;
        assertEq(usdc.balanceOf(trueWinnerAddr), before + prize, "true winner paid, not the liar's claim");
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Resolved));
    }

    function test_challenge_revertAfterWindow() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory t,) = _buildFullTranscript(id, startTurn);
        vm.prank(alice);
        escrow.proposeResult(id, 0, bytes32(uint256(1)));

        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(bytes("MatchEscrow: window closed"));
        vm.prank(bob);
        escrow.challenge(id, t);
    }

    function test_challenge_revertSessionMismatch() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory t,) = _buildFullTranscript(id, startTurn);
        t.session0 = address(0xBEEF);
        vm.prank(alice);
        escrow.proposeResult(id, 0, bytes32(uint256(1)));
        vm.expectRevert(bytes("MatchEscrow: session mismatch"));
        vm.prank(bob);
        escrow.challenge(id, t);
    }

    // ------------------------------- admin ------------------------------ //

    function test_setRake_boundedByMax() public {
        vm.prank(owner);
        escrow.setRake(1000);
        assertEq(escrow.rakeBps(), 1000);

        vm.prank(owner);
        vm.expectRevert(bytes("MatchEscrow: rake too high"));
        escrow.setRake(1001);
    }

    function test_setRake_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        escrow.setRake(100);
    }

    function test_constructor_revertRakeTooHigh() public {
        vm.expectRevert(bytes("MatchEscrow: rake too high"));
        new MatchEscrow(address(verifier), treasury, 1001, WINDOW, TTL, owner);
    }

    // ----------------------- audit-driven hardening --------------------- //

    // [M-01] only allowlisted tokens may be staked
    function test_createMatch_revertTokenNotAllowed() public {
        MockERC20 rando = new MockERC20("Rando", "RND", 18);
        rando.mint(alice, 1e21);
        vm.startPrank(alice);
        rando.approve(address(escrow), type(uint256).max);
        vm.expectRevert(bytes("MatchEscrow: token not allowed"));
        escrow.createMatch(address(rando), STAKE, session0);
        vm.stopPrank();
    }

    // [M-02] rake is snapshotted at creation; a later setRake cannot change it
    function test_rakeSnapshot_unaffectedByLaterSetRake() public {
        uint256 id = _createAndJoin(); // created at RAKE_BPS = 250
        vm.prank(owner);
        escrow.setRake(1000); // owner hikes rake to the 10% cap afterwards

        uint256 aliceBefore = usdc.balanceOf(alice);
        escrow.settleSigned(id, 0, _signResult(pk0, id, 0), _signResult(pk1, id, 0));

        uint256 pot = uint256(STAKE) * 2;
        uint256 expectedPrize = pot - (pot * RAKE_BPS) / 10_000; // still the original 2.5%
        assertEq(usdc.balanceOf(alice), aliceBefore + expectedPrize, "uses snapshotted rake");
    }

    // [M-03] an unsettled match can always be reclaimed after the TTL
    function test_voidExpired_refundsBothAfterTtl() public {
        uint256 id = _createAndJoin();
        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);

        vm.expectRevert(bytes("MatchEscrow: not expired"));
        vm.prank(alice);
        escrow.voidExpired(id);

        vm.warp(block.timestamp + TTL + 1);
        vm.prank(bob);
        escrow.voidExpired(id);

        assertEq(usdc.balanceOf(alice), aBefore + STAKE, "alice refunded");
        assertEq(usdc.balanceOf(bob), bBefore + STAKE, "bob refunded");
        assertEq(usdc.balanceOf(treasury), 0, "no rake on a void");
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Voided));
    }

    // [H-01] a premature proposal (game not over) is defeated: challenge with a
    //        valid non-terminal transcript that matches the proposer's commitment voids
    //        the match and refunds both players.
    function test_challenge_voidsPrematureProposal() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;

        // a short, valid, NON-terminal transcript (a handful of opening moves)
        ReplayVerifier.Transcript memory t = _buildPartialTranscript(id, startTurn, 6);

        // proposer commits to the hash of the partial transcript they witnessed
        bytes32 commitment = verifier.transcriptHash(id, startTurn, t.moves);

        // liar claims to have won a game that is still in progress
        vm.prank(alice);
        escrow.proposeResult(id, 0, commitment);

        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);
        // bob (the non-proposer) challenges with the same transcript — hash matches → void
        vm.prank(bob);
        escrow.challenge(id, t);

        assertEq(usdc.balanceOf(alice), aBefore + STAKE, "alice refunded, not paid the pot");
        assertEq(usdc.balanceOf(bob), bBefore + STAKE, "bob refunded");
        assertEq(usdc.balanceOf(treasury), 0, "no rake");
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Voided));
    }

    // [H-02b] partial transcript with wrong commitment is rejected
    function test_challenge_revertTranscriptMismatch() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;

        // short non-terminal transcript (6 moves)
        ReplayVerifier.Transcript memory shortT = _buildPartialTranscript(id, startTurn, 6);

        // proposer commits to a DIFFERENT hash (attacker scenario: wrong commitment)
        vm.prank(alice);
        escrow.proposeResult(id, 0, bytes32(uint256(0xDEAD)));

        // loser submits the short transcript, but its hash ≠ commitment → revert
        vm.expectRevert(bytes("MatchEscrow: transcript mismatch"));
        vm.prank(bob);
        escrow.challenge(id, shortT);
    }

    // [fix2] challengeWindow snapshot — owner change after join must not affect in-flight match
    function test_challengeWindowSnapshot_unaffectedByOwnerChange() public {
        uint256 id = _createAndJoin();

        // owner doubles the challenge window after the match is created
        vm.prank(owner);
        escrow.setChallengeWindow(WINDOW * 2);

        // propose and measure the actual deadline stored in the match
        vm.prank(alice);
        uint64 before = uint64(block.timestamp);
        escrow.proposeResult(id, 0, bytes32(uint256(1)));
        MatchEscrow.Match memory m = escrow.getMatch(id);

        // deadline should use the snapshotted window (WINDOW), not the new doubled one
        assertEq(m.challengeDeadline, before + WINDOW, "uses snapshotted window");
    }

    // [fix2] setChallengeWindow must enforce minimum
    function test_setChallengeWindow_revertBelowMin() public {
        uint64 minWindow = escrow.MIN_CHALLENGE_WINDOW(); // read before prank to avoid consuming it
        vm.prank(owner);
        vm.expectRevert(bytes("MatchEscrow: window too short"));
        escrow.setChallengeWindow(minWindow - 1);
    }

    // [fix3] voidExpired also works when the match is Proposed but the TTL has elapsed
    function test_voidExpired_worksOnProposedExpiredMatch() public {
        uint256 id = _createAndJoin();

        // propose before TTL expires
        vm.prank(alice);
        escrow.proposeResult(id, 0, bytes32(uint256(1)));
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Proposed));

        // TTL elapses (activeDeadline passes) while match is still Proposed
        vm.warp(block.timestamp + TTL + 1);

        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        escrow.voidExpired(id);

        assertEq(usdc.balanceOf(alice), aBefore + STAKE, "alice refunded");
        assertEq(usdc.balanceOf(bob), bBefore + STAKE, "bob refunded");
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Voided));
    }

    // [H-02] empty transcript must be rejected — not treated as "game still live"
    function test_challenge_revertEmptyTranscript() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;

        vm.prank(alice);
        escrow.proposeResult(id, 0, bytes32(uint256(1)));

        MatchEscrow.Match memory m = escrow.getMatch(id);
        ReplayVerifier.Transcript memory empty = ReplayVerifier.Transcript({
            matchId: id,
            session0: m.session0,
            session1: m.session1,
            startTurn: startTurn,
            moves: new uint8[](0),
            sigs: new bytes[](0)
        });
        vm.expectRevert(bytes("ReplayVerifier: empty transcript"));
        vm.prank(bob);
        escrow.challenge(id, empty);
    }

    // [L-04] non-player cannot call challenge
    function test_challenge_revertNonPlayer() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory t,) = _buildFullTranscript(id, startTurn);
        vm.prank(alice);
        escrow.proposeResult(id, 0, bytes32(uint256(1)));

        vm.expectRevert(bytes("MatchEscrow: not a player"));
        vm.prank(address(0xdead));
        escrow.challenge(id, t);
    }

    // [M-04] proposeResult must revert on an expired match
    function test_proposeResult_revertAfterExpiry() public {
        uint256 id = _createAndJoin();
        vm.warp(block.timestamp + TTL + 1);
        vm.expectRevert(bytes("MatchEscrow: match expired"));
        vm.prank(alice);
        escrow.proposeResult(id, 0, bytes32(uint256(1)));
    }

    // ------------------------- stake floor ------------------------------- //

    function test_minStake_defaultsToZero_noFloor() public view {
        assertEq(escrow.minStake(), 0);
    }

    function test_setMinStake_blocksDustMatches() public {
        vm.prank(owner);
        escrow.setMinStake(STAKE); // floor at the standard stake

        // below the floor reverts
        vm.prank(alice);
        vm.expectRevert(bytes("MatchEscrow: stake below floor"));
        escrow.createMatch(address(usdc), STAKE - 1, session0);

        // at/above the floor still works
        vm.prank(alice);
        uint256 id = escrow.createMatch(address(usdc), STAKE, session0);
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Open));
    }

    function test_setMinStake_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        escrow.setMinStake(STAKE);
    }

    function _buildPartialTranscript(uint256 matchId, uint8 startTurn, uint256 plies)
        internal
        returns (ReplayVerifier.Transcript memory t)
    {
        delete _moves;
        delete _sigs;
        AwaleRules.GameState memory s = AwaleRules.initialState();
        s.turn = startTurn;
        for (uint256 ply = 0; ply < plies && !s.over; ply++) {
            uint8 house = _lowest(AwaleRules.legalMovesMask(s));
            uint256 pk = s.turn == 0 ? pk0 : pk1;
            _moves.push(house);
            _sigs.push(_signMove(pk, matchId, ply, house));
            s = AwaleRules.applyMove(s, house);
        }
        require(!s.over, "transcript unexpectedly terminal");
        t = ReplayVerifier.Transcript({
            matchId: matchId, session0: session0, session1: session1, startTurn: startTurn, moves: _moves, sigs: _sigs
        });
    }
}
