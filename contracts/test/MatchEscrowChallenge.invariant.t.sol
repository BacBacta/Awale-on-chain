// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MatchEscrow} from "../src/MatchEscrow.sol";
import {ReplayVerifier} from "../src/ReplayVerifier.sol";
import {AwaleRules} from "../src/AwaleRules.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev Invariant fuzz for the DISPUTE path — the piece the lifecycle invariant
///      suite (MatchEscrow.invariant.t.sol) deliberately leaves out. After the
///      Finding-1 fix, a result is PROVEN at propose time: {proposeResult}
///      replays the full signed transcript on-chain and can only ever set the
///      canonical winner, and a NON-terminal (unfinished) game can never be
///      proposed at all. So every match here is driven to Proposed with the
///      canonical winner and then settled one of two ways:
///        - challengeTerminal: a keeper replays the full transcript → the
///          canonical winner is paid instantly (permissionless backstop);
///        - finalizeProposed:  window elapses → the same canonical winner is paid.
///      A third action, tryProposePremature, asserts the fix structurally: a
///      non-terminal proposal ALWAYS reverts, so a losing/abandoning player can
///      never convert an unfinished game into a payout or a self-serving void.
///      Money ghosts are delta-measured; on top of solvency/conservation/rake,
///      a dispute flag asserts settlement NEVER pays anyone but the canonical
///      winner.
///
///      Transcript signing dominates runtime (~100 ECDSA signs per challenge),
///      so the invariant functions carry inline forge-config with reduced
///      runs/depth instead of the global 256×500.
contract ChallengeHandler is Test {
    MatchEscrow public escrow;
    ReplayVerifier public verifier;
    MockERC20 public usdc;
    address public treasury;
    address public owner;

    uint256 internal pk0 = 0xA11CE;
    uint256 internal pk1 = 0xB0B;
    address internal session0;
    address internal session1;

    address[4] public players;

    uint256[] public ids;
    uint256 internal constant MAX_MATCHES = 24;
    uint256 internal constant PARTIAL_PLIES = 2; // premature (non-terminal) transcript length

    // canonical self-play (lowest legal house each ply), precomputed per startTurn
    uint8[] internal movesFrom0;
    uint8[] internal movesFrom1;
    uint8 internal winnerFrom0;
    uint8 internal winnerFrom1;

    // money ghosts (delta-measured)
    uint256 public ghostIn;
    uint256 public ghostOut;
    uint256 public ghostRake;

    // dispute-specific violation flags (set AFTER a successful call, so they
    // persist — a revert inside the call would discard the whole invocation)
    bool public badCanonicalPayout; // settlement paid the wrong party
    bool public prematureAccepted; // a NON-terminal proposal was (wrongly) accepted

    constructor(MatchEscrow e, ReplayVerifier v, MockERC20 t, address treasury_, address owner_) {
        escrow = e;
        verifier = v;
        usdc = t;
        treasury = treasury_;
        owner = owner_;
        session0 = vm.addr(pk0);
        session1 = vm.addr(pk1);
        for (uint256 i; i < 4; i++) {
            address who = address(uint160(0xC0FFEE0 + i));
            players[i] = who;
            usdc.mint(who, 1_000_000_000_000);
            vm.prank(who);
            usdc.approve(address(escrow), type(uint256).max);
        }
        (movesFrom0, winnerFrom0) = _selfPlay(0);
        (movesFrom1, winnerFrom1) = _selfPlay(1);
    }

    /// Deterministic lowest-legal self-play to termination — the same canonical
    /// game the unit tests replay, reused for every fuzzed match of a startTurn.
    function _selfPlay(uint8 startTurn) internal pure returns (uint8[] memory moves, uint8 winner) {
        AwaleRules.GameState memory s = AwaleRules.initialState();
        s.turn = startTurn;
        uint8[] memory buf = new uint8[](5000);
        uint256 n = 0;
        while (!s.over && n < 5000) {
            uint8 mask = AwaleRules.legalMovesMask(s);
            require(mask != 0, "no legal move");
            uint8 house = 0;
            while (mask & (uint8(1) << house) == 0) house++;
            buf[n++] = house;
            s = AwaleRules.applyMove(s, house);
        }
        require(s.over, "self-play did not terminate");
        moves = new uint8[](n);
        for (uint256 i; i < n; i++) moves[i] = buf[i];
        winner = s.winner;
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function _pickProposed(uint256 seed, bool inWindow) internal view returns (uint256) {
        uint256 n = ids.length;
        if (n == 0) return type(uint256).max;
        uint256 start = seed % n;
        for (uint256 k; k < n; k++) {
            uint256 id = ids[(start + k) % n];
            MatchEscrow.Match memory m = escrow.getMatch(id);
            if (m.status != MatchEscrow.Status.Proposed) continue;
            if (inWindow && block.timestamp > m.challengeDeadline) continue;
            return id;
        }
        return type(uint256).max;
    }

    /// Sign the first `count` canonical moves for this match (signatures bind
    /// matchId + ply, so they cannot be precomputed across matches).
    function _signedTranscript(uint256 matchId, uint8 startTurn, uint256 count)
        internal
        view
        returns (ReplayVerifier.Transcript memory t)
    {
        uint8[] memory all = startTurn == 0 ? movesFrom0 : movesFrom1;
        uint8[] memory mv = new uint8[](count);
        bytes[] memory sg = new bytes[](count);
        // replay the position alongside so each signature binds its pre-move state
        AwaleRules.GameState memory st = AwaleRules.initialState();
        st.turn = startTurn;
        for (uint256 ply = 0; ply < count; ply++) {
            mv[ply] = all[ply];
            uint256 pk = st.turn == 0 ? pk0 : pk1;
            (uint8 v, bytes32 r, bytes32 sig) = vm.sign(pk, verifier.moveDigest(matchId, ply, all[ply], verifier.stateHash(st)));
            sg[ply] = abi.encodePacked(r, sig, v);
            st = AwaleRules.applyMove(st, all[ply]);
        }
        t.matchId = matchId;
        t.session0 = session0;
        t.session1 = session1;
        t.startTurn = startTurn;
        t.moves = mv;
        t.sigs = sg;
    }

    /// Create + join + fix the flip, returning a match ready to propose.
    function _createActive(address creator, address joiner, uint128 stake) internal returns (uint256 id) {
        uint256 eb = usdc.balanceOf(address(escrow));
        vm.prank(creator);
        id = escrow.createMatch(address(usdc), stake, session0);
        vm.prank(joiner);
        escrow.joinMatch(id, session1);
        ghostIn += usdc.balanceOf(address(escrow)) - eb;
        ids.push(id);

        vm.roll(block.number + uint256(escrow.START_REVEAL_DELAY()) + 1);
        escrow.finalizeStart(id);
    }

    // ------------------------------ actions ----------------------------- //

    /// Drive a fresh match to Proposed by PROVING the finished game on-chain.
    /// The proposed winner is always the canonical winner — a false claim is no
    /// longer expressible.
    function createToProposed(uint256 who, uint256 amount) external {
        if (ids.length >= MAX_MATCHES) return;
        address creator = players[who % 4];
        address joiner = players[(who + 1) % 4];
        uint128 stake = uint128(bound(amount, 1, 100_000_000));

        uint256 id = _createActive(creator, joiner, stake);
        uint8 startTurn = escrow.getMatch(id).startTurn;

        uint256 fullLen = startTurn == 0 ? movesFrom0.length : movesFrom1.length;
        ReplayVerifier.Transcript memory t = _signedTranscript(id, startTurn, fullLen);
        vm.prank(creator);
        escrow.proposeResult(id, t);

        uint8 canon = startTurn == 0 ? winnerFrom0 : winnerFrom1;
        if (escrow.getMatch(id).proposedWinner != canon) badCanonicalPayout = true;
    }

    /// The fix, asserted structurally: proposing a NON-terminal (unfinished)
    /// game must ALWAYS revert. If it ever succeeds, a losing/abandoning player
    /// could steal — the flag trips the invariant.
    function tryProposePremature(uint256 who, uint256 amount, uint256 plies) external {
        if (ids.length >= MAX_MATCHES) return;
        address creator = players[who % 4];
        address joiner = players[(who + 1) % 4];
        uint128 stake = uint128(bound(amount, 1, 100_000_000));

        uint256 id = _createActive(creator, joiner, stake);
        uint8 startTurn = escrow.getMatch(id).startTurn;

        uint256 count = bound(plies, 1, PARTIAL_PLIES + 4); // short → non-terminal
        ReplayVerifier.Transcript memory t = _signedTranscript(id, startTurn, count);
        vm.prank(creator);
        try escrow.proposeResult(id, t) {
            prematureAccepted = true; // MUST NOT happen
        } catch {}
        // the match stays Active and is backed by ghostIn → conservation holds
    }

    /// Challenge with the FULL transcript: a keeper (non-player) settles the
    /// Proposed match instantly to the canonical winner.
    function challengeTerminal(uint256 seed) external {
        uint256 id = _pickProposed(seed, true);
        if (id == type(uint256).max) return;
        MatchEscrow.Match memory m = escrow.getMatch(id);
        uint256 fullLen = m.startTurn == 0 ? movesFrom0.length : movesFrom1.length;
        ReplayVerifier.Transcript memory t = _signedTranscript(id, m.startTurn, fullLen);

        uint8 canon = m.startTurn == 0 ? winnerFrom0 : winnerFrom1;
        address winnerAddr = canon == 0 ? m.player0 : m.player1;
        uint256 wb = usdc.balanceOf(winnerAddr);
        uint256 eb = usdc.balanceOf(address(escrow));
        uint256 tb = usdc.balanceOf(treasury);

        // a NON-player keeper submits the terminal transcript — the anti-theft
        // backstop path. It must pay the canonical winner exactly as a player
        // would, proving the permissionless-terminal branch never harms anyone.
        vm.prank(address(0xC0FFEE));
        escrow.challenge(id, t);

        ghostOut += eb - usdc.balanceOf(address(escrow));
        ghostRake += usdc.balanceOf(treasury) - tb;

        // canonical-payout check (runs only after success, so the flag persists)
        if (escrow.getMatch(id).status != MatchEscrow.Status.Resolved) badCanonicalPayout = true;
        if (canon == 2) {
            // canonical draw: each player got their stake back, no rake
            if (usdc.balanceOf(treasury) != tb) badCanonicalPayout = true;
        } else {
            uint256 pot = uint256(m.stake) * 2;
            uint256 prize = pot - (pot * m.rakeBps) / escrow.BPS();
            if (usdc.balanceOf(winnerAddr) != wb + prize) badCanonicalPayout = true;
        }
    }

    /// Let the window lapse and pay the standing (proven) claim.
    function finalizeProposed(uint256 seed, uint256 dt) external {
        uint256 id = _pickProposed(seed, false);
        if (id == type(uint256).max) return;
        MatchEscrow.Match memory m = escrow.getMatch(id);
        vm.warp(uint256(m.challengeDeadline) + bound(dt, 1, 1 days));

        uint8 canon = m.startTurn == 0 ? winnerFrom0 : winnerFrom1;
        address winnerAddr = canon == 0 ? m.player0 : m.player1;
        uint256 wb = usdc.balanceOf(winnerAddr);
        uint256 eb = usdc.balanceOf(address(escrow));
        uint256 tb = usdc.balanceOf(treasury);
        escrow.finalize(id);
        ghostOut += eb - usdc.balanceOf(address(escrow));
        ghostRake += usdc.balanceOf(treasury) - tb;

        if (canon != 2) {
            uint256 pot = uint256(m.stake) * 2;
            uint256 prize = pot - (pot * m.rakeBps) / escrow.BPS();
            if (usdc.balanceOf(winnerAddr) != wb + prize) badCanonicalPayout = true;
        }
    }

    /// Drive a fresh match into a move-clock forfeit and abandon it: the present
    /// player claims, the window lapses, and finalizeForfeit pays them the pot.
    /// Exercises the forfeit payout under the conservation/rake invariants.
    function createAndForfeit(uint256 who, uint256 amount, uint256 dt) external {
        if (ids.length >= MAX_MATCHES) return;
        address creator = players[who % 4];
        address joiner = players[(who + 1) % 4];
        uint128 stake = uint128(bound(amount, 1, 100_000_000));

        uint256 id = _createActive(creator, joiner, stake);
        uint8 startTurn = escrow.getMatch(id).startTurn;

        // a short, non-terminal prefix; the accused is whoever must move next
        ReplayVerifier.Transcript memory t = _signedTranscript(id, startTurn, PARTIAL_PLIES);
        uint8 accusedIdx = uint8((uint256(startTurn) + PARTIAL_PLIES) % 2);
        address claimant = accusedIdx == 0 ? joiner : creator; // the OTHER player

        // the accused's turn-ack over the exact forfeit position (v2 requirement)
        AwaleRules.GameState memory st = AwaleRules.initialState();
        st.turn = startTurn;
        uint8[] memory all = startTurn == 0 ? movesFrom0 : movesFrom1;
        for (uint256 i = 0; i < PARTIAL_PLIES; i++) st = AwaleRules.applyMove(st, all[i]);
        uint256 apk = st.turn == 0 ? pk0 : pk1;
        (uint8 av, bytes32 ar, bytes32 asig) = vm.sign(apk, verifier.ackDigest(id, PARTIAL_PLIES, verifier.stateHash(st)));
        bytes memory ack = abi.encodePacked(ar, asig, av);

        vm.prank(claimant);
        try escrow.proposeForfeit(id, t, ack) {} catch { return; }

        uint64 dl = escrow.getMatch(id).challengeDeadline;
        vm.warp(uint256(dl) + bound(dt, 1, 1 days));

        uint256 cb = usdc.balanceOf(claimant);
        uint256 eb = usdc.balanceOf(address(escrow));
        uint256 tb = usdc.balanceOf(treasury);
        escrow.finalizeForfeit(id); // permissionless
        ghostOut += eb - usdc.balanceOf(address(escrow));
        ghostRake += usdc.balanceOf(treasury) - tb;

        // the claimant must receive exactly pot - rake, and the match resolves
        uint256 pot = uint256(stake) * 2;
        uint256 prize = pot - (pot * escrow.getMatch(id).rakeBps) / escrow.BPS();
        if (usdc.balanceOf(claimant) != cb + prize) badCanonicalPayout = true;
        if (escrow.getMatch(id).status != MatchEscrow.Status.Resolved) badCanonicalPayout = true;
    }

    function setRake(uint16 r) external {
        uint16 capped = uint16(bound(r, 0, escrow.MAX_RAKE_BPS()));
        vm.prank(owner);
        escrow.setRake(capped);
    }

    /// Stakes still owed to live matches.
    function lockedObligations() external view returns (uint256 locked) {
        uint256 n = ids.length;
        for (uint256 i; i < n; i++) {
            MatchEscrow.Match memory m = escrow.getMatch(ids[i]);
            if (m.status == MatchEscrow.Status.Open) locked += m.stake;
            else if (m.status == MatchEscrow.Status.Active || m.status == MatchEscrow.Status.Proposed) {
                locked += uint256(m.stake) * 2;
            }
        }
    }
}

contract MatchEscrowChallengeInvariantTest is Test {
    MatchEscrow internal escrow;
    ReplayVerifier internal verifier;
    MockERC20 internal usdc;
    ChallengeHandler internal handler;

    address internal owner = address(0x0E1);
    address internal treasury = address(0x7EA);

    function setUp() public {
        verifier = new ReplayVerifier();
        escrow = new MatchEscrow(address(verifier), treasury, 1100, 600, 1 days, owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        vm.prank(owner);
        escrow.setTokenAllowed(address(usdc), true);

        handler = new ChallengeHandler(escrow, verifier, usdc, treasury, owner);
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 60
    function invariant_settlementPaysOnlyTheCanonicalWinner() public view {
        assertFalse(handler.badCanonicalPayout(), "settlement paid someone else");
    }

    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 60
    function invariant_nonTerminalProposalAlwaysReverts() public view {
        assertFalse(handler.prematureAccepted(), "a non-terminal (premature) proposal was accepted");
    }

    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 60
    function invariant_escrowExactlyBacksLiveMatches() public view {
        assertEq(usdc.balanceOf(address(escrow)), handler.lockedObligations(), "escrow balance != live obligations");
    }

    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 60
    function invariant_conservationAndRake() public view {
        assertEq(handler.ghostIn(), usdc.balanceOf(address(escrow)) + handler.ghostOut(), "tokens leaked");
        assertEq(usdc.balanceOf(treasury), handler.ghostRake(), "treasury != cumulative rake");
    }
}
