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

    function _signMove(uint256 pk, uint256 matchId, uint256 ply, uint8 house, bytes32 st)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, verifier.moveDigest(matchId, ply, house, st));
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
            _sigs.push(_signMove(pk, matchId, ply, house, verifier.stateHash(s)));
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

    /// @dev First `k` moves/sigs of a transcript — the forfeit prefix a rebuttal
    ///      must extend by exactly one move.
    function _truncate(ReplayVerifier.Transcript memory full, uint256 k)
        internal
        pure
        returns (ReplayVerifier.Transcript memory t)
    {
        uint8[] memory mv = new uint8[](k);
        bytes[] memory sg = new bytes[](k);
        for (uint256 i = 0; i < k; i++) {
            mv[i] = full.moves[i];
            sg[i] = full.sigs[i];
        }
        t = ReplayVerifier.Transcript({
            matchId: full.matchId,
            session0: full.session0,
            session1: full.session1,
            startTurn: full.startTurn,
            moves: mv,
            sigs: sg
        });
    }

    /// @dev Given the accused is whoever must move after `plies` moves, return the
    ///      forfeit claimant (the other player) and the accused address.
    function _forfeitRoles(uint8 startTurn, uint256 plies)
        internal
        view
        returns (address claimant, address accused)
    {
        uint8 accusedIdx = uint8((uint256(startTurn) + plies) % 2);
        accused = accusedIdx == 0 ? alice : bob;
        claimant = accusedIdx == 0 ? bob : alice;
    }

    /// @dev The lowest-legal-move state at ply `plies` — matches _buildPartialTranscript.
    function _stateAtPly(uint8 startTurn, uint256 plies) internal pure returns (AwaleRules.GameState memory s) {
        s = AwaleRules.initialState();
        s.turn = startTurn;
        for (uint256 ply = 0; ply < plies; ply++) {
            s = AwaleRules.applyMove(s, _lowest(AwaleRules.legalMovesMask(s)));
        }
    }

    /// @dev A TurnAck signature over the position at `ply`, signed by key `pk`.
    function _ackWith(uint256 pk, uint256 matchId, uint256 ply, bytes32 sh) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(pk, verifier.ackDigest(matchId, ply, sh));
        return abi.encodePacked(r, sig, v);
    }

    /// @dev The ACCUSED's valid turn-ack for a forfeit at ply `plies` (their turn).
    function _forfeitAck(uint256 matchId, uint8 startTurn, uint256 plies) internal view returns (bytes memory) {
        AwaleRules.GameState memory s = _stateAtPly(startTurn, plies);
        uint256 pk = s.turn == 0 ? pk0 : pk1; // the accused (whoever is to move)
        return _ackWith(pk, matchId, plies, verifier.stateHash(s));
    }

    /// @dev A well-formed but empty Transcript, for reverts that fire before the
    ///      transcript body is ever read (status / deadline / player / startTurn).
    function _emptyTranscript(uint256 matchId) internal view returns (ReplayVerifier.Transcript memory t) {
        t = ReplayVerifier.Transcript({
            matchId: matchId,
            session0: session0,
            session1: session1,
            startTurn: 0,
            moves: new uint8[](0),
            sigs: new bytes[](0)
        });
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
        escrow.proposeResult(id, _emptyTranscript(id));
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
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory t, uint8 winner) = _buildFullTranscript(id, startTurn);
        assertLt(winner, 2, "deterministic game is decisive");

        // winner is PROVEN on-chain from the signed transcript, not asserted
        vm.prank(alice);
        escrow.proposeResult(id, t);
        assertEq(escrow.getMatch(id).proposedWinner, winner, "proposed winner = verifier winner");

        // cannot finalize before the window elapses
        vm.expectRevert(bytes("MatchEscrow: window open"));
        escrow.finalize(id);

        vm.warp(block.timestamp + WINDOW + 1);
        address winnerAddr = winner == 0 ? alice : bob;
        uint256 before = usdc.balanceOf(winnerAddr);
        escrow.finalize(id);

        uint256 prize = (uint256(STAKE) * 2) - (uint256(STAKE) * 2 * RAKE_BPS) / 10_000;
        assertEq(usdc.balanceOf(winnerAddr), before + prize, "proven winner paid");
    }

    function test_proposeByNonPlayer_reverts() public {
        uint256 id = _createAndJoin();
        vm.prank(address(0xdead));
        vm.expectRevert(bytes("MatchEscrow: not a player"));
        escrow.proposeResult(id, _emptyTranscript(id));
    }

    // ------------------------------ challenge --------------------------- //

    // A proposed result is already proven at propose time; challenge settles it
    // immediately (skipping the window) by replaying the same terminal transcript.
    function test_challenge_settlesProvenResultInstantly() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory t, uint8 winner) = _buildFullTranscript(id, startTurn);
        assertLt(winner, 2, "deterministic game is decisive");

        vm.prank(bob);
        escrow.proposeResult(id, t);

        address winnerAddr = winner == 0 ? alice : bob;
        uint256 before = usdc.balanceOf(winnerAddr);

        vm.prank(alice);
        escrow.challenge(id, t);

        uint256 prize = (uint256(STAKE) * 2) - (uint256(STAKE) * 2 * RAKE_BPS) / 10_000;
        assertEq(usdc.balanceOf(winnerAddr), before + prize, "proven winner paid");
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Resolved));
    }

    function test_challenge_revertAfterWindow() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory t,) = _buildFullTranscript(id, startTurn);
        vm.prank(alice);
        escrow.proposeResult(id, t);

        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(bytes("MatchEscrow: window closed"));
        vm.prank(bob);
        escrow.challenge(id, t);
    }

    function test_challenge_revertSessionMismatch() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory t,) = _buildFullTranscript(id, startTurn);
        vm.prank(alice);
        escrow.proposeResult(id, t);

        // challenge with a transcript whose session no longer matches the match
        t.session0 = address(0xBEEF);
        vm.expectRevert(bytes("MatchEscrow: session mismatch"));
        vm.prank(bob);
        escrow.challenge(id, t);
    }

    // ------------------------------- admin ------------------------------ //

    function test_setRake_boundedByMax() public {
        vm.prank(owner);
        escrow.setRake(2000);
        assertEq(escrow.rakeBps(), 2000);

        vm.prank(owner);
        vm.expectRevert(bytes("MatchEscrow: rake too high"));
        escrow.setRake(2001);
    }

    function test_setRake_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        escrow.setRake(100);
    }

    function test_constructor_revertRakeTooHigh() public {
        vm.expectRevert(bytes("MatchEscrow: rake too high"));
        new MatchEscrow(address(verifier), treasury, 2001, WINDOW, TTL, owner);
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

    // [Finding-1 fix] a premature/false proposal is now impossible at the SOURCE:
    // proposeResult replays the transcript on-chain and rejects any non-terminal
    // (unfinished) game — a game with no winner can never be proposed for payout.
    function test_proposeResult_revertsOnNonTerminalGame() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;

        // a short, valid, NON-terminal transcript (a handful of opening moves)
        ReplayVerifier.Transcript memory partialT = _buildPartialTranscript(id, startTurn, 6);

        vm.prank(alice);
        vm.expectRevert(bytes("MatchEscrow: game not over"));
        escrow.proposeResult(id, partialT);
    }

    // [Finding-1 fix] the core exploit end-to-end: a losing/abandoning player tries
    // to steal by claiming a win on a non-terminal game. proposeResult rejects it,
    // and the honest outcome is a full refund of BOTH stakes via voidExpired —
    // nobody wins an unfinished game, nobody's stake is stolen.
    function test_finding1_abandonmentRefundsBothCannotSteal() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        ReplayVerifier.Transcript memory partialT = _buildPartialTranscript(id, startTurn, 4);

        // attacker (bob) abandons mid-game and tries to grab the pot
        vm.prank(bob);
        vm.expectRevert(bytes("MatchEscrow: game not over"));
        escrow.proposeResult(id, partialT);

        // the only path forward is a TTL refund to both players
        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);
        vm.warp(block.timestamp + TTL + 1);
        escrow.voidExpired(id);
        assertEq(usdc.balanceOf(alice), aBefore + STAKE, "alice refunded, not robbed");
        assertEq(usdc.balanceOf(bob), bBefore + STAKE, "bob refunded, gained nothing");
        assertEq(usdc.balanceOf(treasury), 0, "no rake on a void");
    }

    // [fix2] challengeWindow snapshot — owner change after join must not affect in-flight match
    function test_challengeWindowSnapshot_unaffectedByOwnerChange() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory t,) = _buildFullTranscript(id, startTurn);

        // owner doubles the challenge window after the match is created
        vm.prank(owner);
        escrow.setChallengeWindow(WINDOW * 2);

        // propose and measure the actual deadline stored in the match
        uint64 before = uint64(block.timestamp);
        vm.prank(alice);
        escrow.proposeResult(id, t);
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

    // [M1] voidExpired must NOT touch a Proposed match: a losing player could
    // otherwise erase a legitimate claim after the TTL and escape with a refund.
    // A Proposed match is never stuck — finalize is permissionless and has no
    // deadline once the challenge window closes.
    function test_voidExpired_revertsOnProposedMatch_finalizeIsTheRemedy() public {
        uint256 id = _createAndJoin();

        // a player proves the finished game before the TTL expires
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory t, uint8 winner) = _buildFullTranscript(id, startTurn);
        assertLt(winner, 2, "deterministic game is decisive");
        address winnerAddr = winner == 0 ? alice : bob;
        vm.prank(alice);
        escrow.proposeResult(id, t);
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Proposed));

        // TTL elapses while the match is still Proposed — the loser tries
        // to void the claim away instead of accepting the loss
        vm.warp(block.timestamp + TTL + 1);
        vm.prank(bob);
        vm.expectRevert(bytes("MatchEscrow: not voidable"));
        escrow.voidExpired(id);

        // the claim settles the intended way: finalize pays the proven winner,
        // permissionless, long after both the window and the TTL
        uint256 wBefore = usdc.balanceOf(winnerAddr);
        escrow.finalize(id);
        uint256 prize = (uint256(STAKE) * 2) - (uint256(STAKE) * 2 * RAKE_BPS) / 10_000;
        assertEq(usdc.balanceOf(winnerAddr), wBefore + prize, "proven winner paid");
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Resolved));
    }

    // [H-02] empty transcript must be rejected — not treated as "game still live"
    function test_challenge_revertEmptyTranscript() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory t,) = _buildFullTranscript(id, startTurn);
        vm.prank(alice);
        escrow.proposeResult(id, t);

        ReplayVerifier.Transcript memory empty = _emptyTranscript(id);
        empty.startTurn = startTurn;
        vm.expectRevert(bytes("ReplayVerifier: empty transcript"));
        vm.prank(bob);
        escrow.challenge(id, empty);
    }

    // [Finding-1 fix] the non-terminal "void" branch of challenge is gone. A
    // non-terminal transcript proves nothing and reverts — there is no longer a
    // proposer-controlled commitment that could gate (or disable) a refund.
    function test_challenge_revertsOnNonTerminalTranscript() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory full,) = _buildFullTranscript(id, startTurn);
        vm.prank(alice);
        escrow.proposeResult(id, full);

        ReplayVerifier.Transcript memory partialT = _buildPartialTranscript(id, startTurn, 6);
        vm.expectRevert(bytes("MatchEscrow: game not over"));
        vm.prank(bob);
        escrow.challenge(id, partialT);
    }

    // [backstop] a non-player (the server's keeper) CAN challenge with a
    // TERMINAL transcript to settle instantly — permissionless, because a
    // terminal transcript can only ever enforce the true, proven winner. This is
    // the anti-theft net when the honest winner is offline for the whole window.
    function test_challenge_nonPlayerCanEnforceTerminalResult() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory t, uint8 winner) = _buildFullTranscript(id, startTurn);
        assertLt(winner, 2, "deterministic game is decisive");

        // a player proposes the (proven) result
        vm.prank(bob);
        escrow.proposeResult(id, t);

        address winnerAddr = winner == 0 ? alice : bob;
        uint256 before = usdc.balanceOf(winnerAddr);

        // a third party (keeper) that is NOT alice/bob settles it instantly
        vm.prank(address(0xC0DE)); // keeper, not a match player
        escrow.challenge(id, t);

        uint256 prize = (uint256(STAKE) * 2) - (uint256(STAKE) * 2 * RAKE_BPS) / 10_000;
        assertEq(usdc.balanceOf(winnerAddr), before + prize, "keeper enforced the true winner");
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Resolved));
    }

    // [M-04] proposeResult must revert on an expired match
    function test_proposeResult_revertAfterExpiry() public {
        uint256 id = _createAndJoin();
        vm.warp(block.timestamp + TTL + 1);
        vm.expectRevert(bytes("MatchEscrow: match expired"));
        vm.prank(alice);
        escrow.proposeResult(id, _emptyTranscript(id));
    }

    // ------------------------- forfeit clock ----------------------------- //

    // Abandonment costs the pot: if the accused never answers, the present
    // player wins the whole pot (minus rake) — losing is no longer free.
    function test_forfeit_finalizePaysClaimantWhenAbandoned() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        uint256 N = 6;
        ReplayVerifier.Transcript memory pfx = _buildPartialTranscript(id, startTurn, N);
        (address claimant,) = _forfeitRoles(startTurn, N);

        bytes memory ack = _forfeitAck(id, startTurn, N); // compute before prank (verifier calls would consume it)
        vm.prank(claimant);
        escrow.proposeForfeit(id, pfx, ack);
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.ForfeitPending));

        vm.expectRevert(bytes("MatchEscrow: window open"));
        escrow.finalizeForfeit(id);

        vm.warp(block.timestamp + WINDOW + 1);
        uint256 before = usdc.balanceOf(claimant);
        escrow.finalizeForfeit(id); // permissionless
        uint256 prize = (uint256(STAKE) * 2) - (uint256(STAKE) * 2 * RAKE_BPS) / 10_000;
        assertEq(usdc.balanceOf(claimant), before + prize, "abandoner forfeits the pot to the present player");
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Resolved));
    }

    // You can only accuse your OPPONENT — never claim a forfeit on your own turn.
    function test_forfeit_cannotClaimOwnTurn() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        uint256 N = 6;
        ReplayVerifier.Transcript memory pfx = _buildPartialTranscript(id, startTurn, N);
        (, address accused) = _forfeitRoles(startTurn, N);
        vm.prank(accused);
        vm.expectRevert(bytes("MatchEscrow: cannot forfeit your own turn"));
        escrow.proposeForfeit(id, pfx, hex"");
    }

    function test_forfeit_nonPlayerCannotPropose() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        ReplayVerifier.Transcript memory pfx = _buildPartialTranscript(id, startTurn, 6);
        vm.prank(address(0xdead));
        vm.expectRevert(bytes("MatchEscrow: not a player"));
        escrow.proposeForfeit(id, pfx, hex"");
    }

    // A finished game has no "opponent's turn" to forfeit — use proposeResult.
    function test_forfeit_revertsOnTerminalPrefix() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory full,) = _buildFullTranscript(id, startTurn);
        vm.prank(alice);
        vm.expectRevert(bytes("MatchEscrow: game over"));
        escrow.proposeForfeit(id, full, hex"");
    }

    // Rebutting with the accused's next legal move proves presence and resumes
    // play — no payout, the game continues. Permissionless (keeper can do it).
    function test_forfeit_rebutResumesGame() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        uint256 N = 6;
        ReplayVerifier.Transcript memory pfx = _buildPartialTranscript(id, startTurn, N);
        ReplayVerifier.Transcript memory reb = _buildPartialTranscript(id, startTurn, N + 1);
        (address claimant,) = _forfeitRoles(startTurn, N);

        bytes memory ack = _forfeitAck(id, startTurn, N); // compute before prank (verifier calls would consume it)
        vm.prank(claimant);
        escrow.proposeForfeit(id, pfx, ack);

        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);
        vm.prank(address(0xC0DE)); // keeper, not a player
        escrow.rebutForfeit(id, reb);

        MatchEscrow.Match memory m = escrow.getMatch(id);
        assertEq(uint8(m.status), uint8(MatchEscrow.Status.Active), "game resumes");
        assertEq(m.lastRebuttedPly, N + 1, "anti-replay floor raised to the proven frontier");
        assertEq(usdc.balanceOf(alice), aBefore, "no payout on resume");
        assertEq(usdc.balanceOf(bob), bBefore, "no payout on resume");
    }

    // If the accused answers with the game-ENDING move, the canonical winner is
    // paid immediately — a grief right before losing backfires.
    function test_forfeit_rebutTerminalPaysCanonicalWinner() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory full, uint8 winner) = _buildFullTranscript(id, startTurn);
        assertLt(winner, 2, "decisive game");
        uint256 M = full.moves.length;
        ReplayVerifier.Transcript memory pfx = _truncate(full, M - 1); // one move from terminal
        (address claimant,) = _forfeitRoles(startTurn, M - 1);

        bytes memory ack = _forfeitAck(id, startTurn, M - 1); // compute before prank
        vm.prank(claimant);
        escrow.proposeForfeit(id, pfx, ack);

        address winnerAddr = winner == 0 ? alice : bob;
        uint256 before = usdc.balanceOf(winnerAddr);
        vm.prank(address(0xC0DE));
        escrow.rebutForfeit(id, full);
        uint256 prize = (uint256(STAKE) * 2) - (uint256(STAKE) * 2 * RAKE_BPS) / 10_000;
        assertEq(usdc.balanceOf(winnerAddr), before + prize, "terminal rebuttal pays the true winner");
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Resolved));
    }

    function test_forfeit_rebutRevertsAfterWindow() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        uint256 N = 6;
        ReplayVerifier.Transcript memory pfx = _buildPartialTranscript(id, startTurn, N);
        ReplayVerifier.Transcript memory reb = _buildPartialTranscript(id, startTurn, N + 1);
        (address claimant,) = _forfeitRoles(startTurn, N);
        bytes memory ack = _forfeitAck(id, startTurn, N); // compute before prank (verifier calls would consume it)
        vm.prank(claimant);
        escrow.proposeForfeit(id, pfx, ack);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(bytes("MatchEscrow: window closed"));
        escrow.rebutForfeit(id, reb);
    }

    // A rebuttal must be strictly LONGER than the committed prefix (≥1 real
    // continuation move); one that isn't is rejected. (Longer-than-+1 is allowed
    // — that's the leapfrog-to-frontier hardening, tested separately.)
    function test_forfeit_rebutTooShort() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        uint256 N = 6;
        ReplayVerifier.Transcript memory pfx = _buildPartialTranscript(id, startTurn, N);
        ReplayVerifier.Transcript memory tooShort = _buildPartialTranscript(id, startTurn, N); // == forfeitPly
        (address claimant,) = _forfeitRoles(startTurn, N);
        bytes memory ack = _forfeitAck(id, startTurn, N); // compute before prank
        vm.prank(claimant);
        escrow.proposeForfeit(id, pfx, ack);
        vm.expectRevert(bytes("MatchEscrow: rebuttal too short"));
        escrow.rebutForfeit(id, tooShort);
    }

    // [re-audit v2 hardening] Reach-back defence: a LOSER opens a stale forfeit at
    // an old ply (with the winner's genuine old ack) naming themselves winner; the
    // true winner escapes in ONE tx by rebutting with the full terminal transcript,
    // which settles to the CANONICAL winner — not the loser.
    function test_forfeit_reachbackTerminalRebuttalSettlesTrueWinner() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        (ReplayVerifier.Transcript memory full, uint8 winner) = _buildFullTranscript(id, startTurn);
        assertLt(winner, 2, "decisive game");

        // an early ply N (far behind the frontier) where it's the WINNER's turn,
        // so the LOSER can reach back and accuse the winner of "abandoning"
        uint256 N = 4;
        while ((uint256(startTurn) + N) % 2 != winner) N++;
        (address claimant, address accused) = _forfeitRoles(startTurn, N);
        assertEq(accused, winner == 0 ? alice : bob, "accused is the true winner");

        ReplayVerifier.Transcript memory stale = _truncate(full, N);
        bytes memory ack = _forfeitAck(id, startTurn, N); // winner's genuine old ack
        vm.prank(claimant);
        escrow.proposeForfeit(id, stale, ack);
        assertEq(escrow.getMatch(id).proposedWinner, claimant == alice ? 0 : 1, "loser named as winner");

        address winnerAddr = winner == 0 ? alice : bob;
        uint256 before = usdc.balanceOf(winnerAddr);
        escrow.rebutForfeit(id, full); // permissionless, one tx, full terminal line
        uint256 prize = (uint256(STAKE) * 2) - (uint256(STAKE) * 2 * RAKE_BPS) / 10_000;
        assertEq(usdc.balanceOf(winnerAddr), before + prize, "true winner paid, stale forfeit defeated");
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Resolved));
    }

    // [re-audit v2 hardening] One leapfrog rebuttal advances the anti-replay floor
    // to the proven frontier, so a losing griefer can't reopen forfeits at every
    // lower ply (no per-ply gauntlet).
    function test_forfeit_leapfrogRebuttalBlocksStaleReforfeit() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        uint256 N = 4;
        ReplayVerifier.Transcript memory pfx = _buildPartialTranscript(id, startTurn, N);
        ReplayVerifier.Transcript memory long = _buildPartialTranscript(id, startTurn, N + 6);
        (address claimant,) = _forfeitRoles(startTurn, N);
        bytes memory ack = _forfeitAck(id, startTurn, N);
        vm.prank(claimant);
        escrow.proposeForfeit(id, pfx, ack);

        escrow.rebutForfeit(id, long); // non-terminal leapfrog → floor jumps to N+6
        assertEq(escrow.getMatch(id).lastRebuttedPly, N + 6, "floor jumped to frontier");

        // re-opening at any ply at/below the frontier is now rejected as stale
        ReplayVerifier.Transcript memory stale = _buildPartialTranscript(id, startTurn, N + 2);
        (address claimant2,) = _forfeitRoles(startTurn, N + 2);
        bytes memory ack2 = _forfeitAck(id, startTurn, N + 2);
        vm.prank(claimant2);
        vm.expectRevert(bytes("MatchEscrow: stale forfeit ply"));
        escrow.proposeForfeit(id, stale, ack2);
    }

    // A pending forfeit can NEVER be refunded away — closes the abandon→refund
    // escape even after the TTL.
    function test_forfeit_blocksVoidExpiredRefund() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        uint256 N = 6;
        ReplayVerifier.Transcript memory pfx = _buildPartialTranscript(id, startTurn, N);
        (address claimant,) = _forfeitRoles(startTurn, N);
        bytes memory ack = _forfeitAck(id, startTurn, N); // compute before prank (verifier calls would consume it)
        vm.prank(claimant);
        escrow.proposeForfeit(id, pfx, ack);

        vm.warp(block.timestamp + TTL + 1);
        vm.expectRevert(bytes("MatchEscrow: not voidable"));
        escrow.voidExpired(id);

        uint256 before = usdc.balanceOf(claimant);
        escrow.finalizeForfeit(id);
        uint256 prize = (uint256(STAKE) * 2) - (uint256(STAKE) * 2 * RAKE_BPS) / 10_000;
        assertEq(usdc.balanceOf(claimant), before + prize, "resolves to the claimant, never a refund");
    }

    // After a rebuttal the same (now-answered) forfeit ply cannot be re-spammed.
    function test_forfeit_antiReplayStalePly() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        uint256 N = 6;
        ReplayVerifier.Transcript memory pfx = _buildPartialTranscript(id, startTurn, N);
        ReplayVerifier.Transcript memory reb = _buildPartialTranscript(id, startTurn, N + 1);
        (address claimant,) = _forfeitRoles(startTurn, N);
        bytes memory ack = _forfeitAck(id, startTurn, N); // compute before prank (verifier calls would consume it)
        vm.prank(claimant);
        escrow.proposeForfeit(id, pfx, ack);
        escrow.rebutForfeit(id, reb); // lastRebuttedPly = N, back to Active

        vm.prank(claimant);
        vm.expectRevert(bytes("MatchEscrow: stale forfeit ply"));
        escrow.proposeForfeit(id, pfx, hex"");
    }

    // [re-audit critical fix] a forfeit WITHOUT the accused's turn-ack reverts.
    // This closes the own-move-equivocation theft: a claimant holds only their
    // OWN session key, so they cannot produce the accused's ack for a fabricated
    // (forked/withheld) "opponent-to-move" position the accused never saw.
    function test_forfeit_revertsWithoutValidAck() public {
        uint256 id = _createAndJoin();
        uint8 startTurn = escrow.getMatch(id).startTurn;
        uint256 N = 6;
        ReplayVerifier.Transcript memory pfx = _buildPartialTranscript(id, startTurn, N);
        (address claimant,) = _forfeitRoles(startTurn, N);
        uint256 claimantPk = claimant == alice ? pk0 : pk1;

        // ack over the correct position but signed by the CLAIMANT (wrong signer)
        bytes memory forgedAck = _ackWith(claimantPk, id, N, verifier.stateHash(_stateAtPly(startTurn, N)));
        vm.prank(claimant);
        vm.expectRevert(bytes("MatchEscrow: missing turn ack"));
        escrow.proposeForfeit(id, pfx, forgedAck);

        // an ack for a DIFFERENT ply (stale/mismatched position) also fails
        bytes memory wrongPlyAck = _forfeitAck(id, startTurn, N + 2);
        vm.prank(claimant);
        vm.expectRevert(bytes("MatchEscrow: missing turn ack"));
        escrow.proposeForfeit(id, pfx, wrongPlyAck);
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
            _sigs.push(_signMove(pk, matchId, ply, house, verifier.stateHash(s)));
            s = AwaleRules.applyMove(s, house);
        }
        require(!s.over, "transcript unexpectedly terminal");
        t = ReplayVerifier.Transcript({
            matchId: matchId, session0: session0, session1: session1, startTurn: startTurn, moves: _moves, sigs: _sigs
        });
    }

    // ------------------- pre-mainnet pass: stuck-money exits ------------------- //

    // voidExpired is PERMISSIONLESS: an expired match is stuck money and the
    // players may be exactly the ones who can no longer act. A keeper (any
    // stranger) can trigger the refund; funds only ever go to the players.
    function test_voidExpired_permissionless_keeperCanFreeStuckStakes() public {
        uint256 id = _createAndJoin();
        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);

        vm.warp(block.timestamp + TTL + 1);
        vm.prank(address(0xdead)); // not a player
        escrow.voidExpired(id);

        assertEq(usdc.balanceOf(alice), aBefore + STAKE, "alice refunded");
        assertEq(usdc.balanceOf(bob), bBefore + STAKE, "bob refunded");
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Voided));
    }

    // an Open table nobody joins expires too — anyone can refund the creator
    function test_voidExpired_expiredOpenRefundsCreator() public {
        vm.prank(alice);
        uint256 id = escrow.createMatch(address(usdc), STAKE, session0);
        uint256 aBefore = usdc.balanceOf(alice);

        vm.expectRevert(bytes("MatchEscrow: not expired"));
        escrow.voidExpired(id);

        vm.warp(block.timestamp + escrow.openTtl() + 1);
        vm.prank(address(0xdead));
        escrow.voidExpired(id);

        assertEq(usdc.balanceOf(alice), aBefore + STAKE, "creator refunded in full");
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Cancelled));
    }

    function test_createMatch_armsOpenDeadline() public {
        vm.prank(alice);
        uint256 id = escrow.createMatch(address(usdc), STAKE, session0);
        assertEq(escrow.getMatch(id).activeDeadline, uint64(block.timestamp) + escrow.openTtl());
    }

    function test_setOpenTtl_onlyOwner() public {
        vm.prank(owner);
        escrow.setOpenTtl(3600);
        assertEq(escrow.openTtl(), 3600);

        vm.prank(alice);
        vm.expectRevert();
        escrow.setOpenTtl(60);
    }

    // ---------------- invite-locked friend matches (v6) ---------------- //

    // The whole point: only the friend holding the link's code can take the
    // seat — a lobby bot can neither join openly nor guess its way in.
    function test_invite_strangerCannotJoin() public {
        bytes32 code = keccak256("the-link-secret");
        vm.prank(alice);
        uint256 id = escrow.createMatchWithInvite(address(usdc), STAKE, session0, keccak256(abi.encodePacked(code)));

        vm.prank(bob);
        vm.expectRevert(bytes("MatchEscrow: invite only"));
        escrow.joinMatch(id, session1);

        vm.prank(bob);
        vm.expectRevert(bytes("MatchEscrow: bad invite code"));
        escrow.joinMatchWithCode(id, session1, keccak256("wrong-guess"));
    }

    function test_invite_friendWithCodeJoins_andPlaysToSettlement() public {
        bytes32 code = keccak256("the-link-secret");
        vm.prank(alice);
        uint256 id = escrow.createMatchWithInvite(address(usdc), STAKE, session0, keccak256(abi.encodePacked(code)));

        vm.prank(bob);
        escrow.joinMatchWithCode(id, session1, code);
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Active));

        // the rest of the lifecycle is IDENTICAL to an open match: settle with
        // both session signatures, rake to treasury per the existing rules
        vm.roll(block.number + uint256(escrow.START_REVEAL_DELAY()) + 1);
        escrow.finalizeStart(id);
        bytes32 digest = escrow.resultDigest(id, 0);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(pk0, digest);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(pk1, digest);
        uint256 aBefore = usdc.balanceOf(alice);
        uint256 tBefore = usdc.balanceOf(treasury);
        escrow.settleSigned(id, 0, abi.encodePacked(r0, s0, v0), abi.encodePacked(r1, s1, v1));

        uint256 pot = uint256(STAKE) * 2;
        uint256 rake = (pot * RAKE_BPS) / 10_000;
        assertEq(usdc.balanceOf(alice), aBefore + pot - rake, "winner paid per existing rules");
        assertEq(usdc.balanceOf(treasury), tBefore + rake, "11%-style rake applies to friend stakes too");
    }

    function test_invite_openMatchesUnchanged() public {
        // a normal open match still joins exactly as before…
        uint256 id = _createAndJoinNoFinalize();
        assertEq(uint8(escrow.getMatch(id).status), uint8(MatchEscrow.Status.Active));
        // …and joinMatchWithCode is reserved for invite-locked matches
        vm.prank(alice);
        uint256 id2 = escrow.createMatch(address(usdc), STAKE, session0);
        vm.prank(bob);
        vm.expectRevert(bytes("MatchEscrow: not invite-locked"));
        escrow.joinMatchWithCode(id2, session1, keccak256("anything"));
    }

    function test_invite_creatorCanStillCancel() public {
        bytes32 code = keccak256("secret");
        vm.prank(alice);
        uint256 id = escrow.createMatchWithInvite(address(usdc), STAKE, session0, keccak256(abi.encodePacked(code)));
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        escrow.cancelMatch(id);
        assertEq(usdc.balanceOf(alice), before + STAKE, "unjoined invite match refunds in full");
    }

    function test_invite_emptyHashRejected() public {
        vm.prank(alice);
        vm.expectRevert(bytes("MatchEscrow: empty invite"));
        escrow.createMatchWithInvite(address(usdc), STAKE, session0, bytes32(0));
    }
}
