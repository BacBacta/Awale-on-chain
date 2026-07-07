// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReplayVerifier} from "./ReplayVerifier.sol";
import {AwaleRules} from "./AwaleRules.sol";

/// @title MatchEscrow — stake custody and settlement for Awalé cash matches
/// @notice Locks both players' stablecoin stakes, registers their per-match
///         session keys, and settles a match by one of three paths:
///
///           1. settleSigned   — happy path: both session keys signed the
///              result, so the payout is instant and unforgeable.
///           2. proposeResult / finalize — abandonment or refusal-to-sign: a
///              participant claims the result, opening a challenge window; the
///              opponent can overturn a false claim via {challenge}.
///           3. challenge      — replays the full signed transcript through
///              {ReplayVerifier}; the on-chain result is canonical.
///
/// @dev All amounts are in the staked token's own units, so 18-dec (USDm) and
///      6-dec (USDC/USDT) stablecoins are handled without normalisation. The
///      rake is taken from the pot at payout and routed to the Treasury.
contract MatchEscrow is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open, // created, awaiting a second player
        Active, // both staked, game in progress off-chain
        Proposed, // a single-party result is in its challenge window
        Resolved, // paid out to a winner (or split on a draw)
        Cancelled, // open match withdrawn before anyone joined
        Voided, // refunded to both players (premature proposal or expiry)
        ForfeitPending // a move-clock forfeit is in its on-chain response window
    }

    struct Match {
        address token; // staked ERC20 stablecoin
        uint128 stake; // per-player stake, in token units
        address player0; // creator (South / AwaleRules player 0)
        address player1; // joiner (North / AwaleRules player 1)
        address session0; // player 0's per-match session key (ephemeral address)
        address session1; // player 1's per-match session key
        Status status;
        uint8 startTurn; // first mover (0 or 1); START_UNSET until the reveal block is mined
        uint8 proposedWinner; // 0, 1, or DRAW — valid while Proposed
        uint16 rakeBps; // rake snapshotted at creation (owner cannot change it mid-match)
        uint64 challengeDeadline; // timestamp the challenge window closes
        uint64 activeDeadline; // timestamp after which an unsettled Active match can be voided
        uint64 revealBlock; // block whose hash fixes startTurn (set at join, unknown to the joiner)
        uint64 challengeWindow; // window duration snapshotted at join (owner cannot change mid-match)
        bytes32 forfeitPrefix; // committed prefix hash of a pending move-clock forfeit
        uint32 forfeitPly; // ply the accused must answer (= length of the committed prefix)
        uint32 lastRebuttedPly; // highest ply already answered by a rebuttal (anti-replay floor)
    }

    uint16 public constant MAX_RAKE_BPS = 2000; // hard cap: rake can never exceed 20%
    uint16 public constant BPS = 10_000;
    uint8 internal constant DRAW = 2;
    uint64 public constant MIN_CHALLENGE_WINDOW = 5 minutes; // owner cannot set below this

    // First-move randomness: the coin flip is derived from the hash of a *future*
    // block chosen at join time, so the joiner cannot grind their address to bias
    // it (all of prevrandao/matchId/addresses are knowable at join, a future
    // blockhash is not). START_UNSET marks a match whose flip is not yet fixed.
    uint8 internal constant START_UNSET = type(uint8).max;
    uint64 public constant START_REVEAL_DELAY = 1; // blocks to wait after join before finalizing

    ReplayVerifier public immutable verifier;
    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant RESULT_TYPEHASH = keccak256("Result(uint256 matchId,uint8 winner)");

    address public treasury;
    uint16 public rakeBps;
    uint64 public challengeWindow;
    uint64 public matchTtl; // how long an Active match may sit unsettled before it can be voided
    uint64 public openTtl; // how long an Open match may wait for a joiner before ANYONE can refund the creator
    uint128 public minStake; // floor on the per-player stake; 0 ⇒ no floor (default)

    uint256 public nextMatchId = 1;
    mapping(uint256 => Match) public matches;
    mapping(address => bool) public allowedToken; // only audited stablecoins may be staked

    /// @notice Invite-locked matches: matchId => keccak256(code). A friend-link
    ///         stake match reserves the seat for whoever holds the link's secret
    ///         code. Without this, any address could take the seat the moment
    ///         the match appears on-chain — friend links bypass the server's
    ///         skill matchmaking, so an open seat is exactly where a shark bot
    ///         would camp to farm beginners. 0 = a normal open match.
    mapping(uint256 => bytes32) public inviteHash;

    event MatchCreated(uint256 indexed matchId, address indexed player0, address token, uint128 stake);
    event MatchInviteLocked(uint256 indexed matchId);
    event MatchJoined(uint256 indexed matchId, address indexed player1, uint64 revealBlock);
    event StartFinalized(uint256 indexed matchId, uint8 startTurn);
    event MatchCancelled(uint256 indexed matchId);
    event MatchVoided(uint256 indexed matchId);
    event ResultProposed(uint256 indexed matchId, uint8 winner, uint64 challengeDeadline);
    event ResultChallenged(uint256 indexed matchId, uint8 canonicalWinner);
    event ForfeitProposed(uint256 indexed matchId, uint8 claimant, uint32 forfeitPly, uint64 deadline);
    event ForfeitRebutted(uint256 indexed matchId, uint32 forfeitPly);
    event MatchSettled(uint256 indexed matchId, uint8 winner, uint256 prize);
    event FeeCollected(uint256 indexed matchId, address indexed token, uint256 amount);

    event RakeUpdated(uint16 rakeBps);
    event MinStakeUpdated(uint128 minStake);
    event ChallengeWindowUpdated(uint64 challengeWindow);
    event MatchTtlUpdated(uint64 matchTtl);
    event OpenTtlUpdated(uint64 openTtl);
    event TreasuryUpdated(address indexed treasury);
    event TokenAllowed(address indexed token, bool allowed);

    constructor(
        address verifier_,
        address treasury_,
        uint16 rakeBps_,
        uint64 challengeWindow_,
        uint64 matchTtl_,
        address owner_
    ) Ownable(owner_) {
        require(verifier_ != address(0), "MatchEscrow: verifier zero");
        require(treasury_ != address(0), "MatchEscrow: treasury zero");
        require(rakeBps_ <= MAX_RAKE_BPS, "MatchEscrow: rake too high");
        require(challengeWindow_ >= MIN_CHALLENGE_WINDOW, "MatchEscrow: window too short");
        verifier = ReplayVerifier(verifier_);
        treasury = treasury_;
        rakeBps = rakeBps_;
        challengeWindow = challengeWindow_;
        matchTtl = matchTtl_;
        openTtl = matchTtl_; // same default; setOpenTtl adjusts independently

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("AwaleMatchEscrow"), keccak256("1"), block.chainid, address(this))
        );
    }

    // ----------------------------- funding ------------------------------ //

    /// @notice Create an open match, locking the creator's stake and session key.
    function createMatch(address token, uint128 stake, address session0)
        external
        nonReentrant
        returns (uint256 matchId)
    {
        matchId = _create(token, stake, session0);
    }

    /// @notice Create a stake match reserved for a FRIEND: only someone who can
    ///         present `code` with keccak256(abi.encodePacked(code)) ==
    ///         `inviteHash_` may take the seat (the code travels in the invite
    ///         link, off-chain). Everything else — rake, session keys,
    ///         settlement, cancel, TTL refunds — is identical to an open match.
    function createMatchWithInvite(address token, uint128 stake, address session0, bytes32 inviteHash_)
        external
        nonReentrant
        returns (uint256 matchId)
    {
        require(inviteHash_ != bytes32(0), "MatchEscrow: empty invite");
        matchId = _create(token, stake, session0);
        inviteHash[matchId] = inviteHash_;
        emit MatchInviteLocked(matchId);
    }

    function _create(address token, uint128 stake, address session0) internal returns (uint256 matchId) {
        require(allowedToken[token], "MatchEscrow: token not allowed");
        require(stake > 0, "MatchEscrow: stake zero");
        // a stake floor kills dust matches whose rake rounds to ~0 yet still cost
        // gas + infra to settle (negative-margin); 0 disables the floor
        require(stake >= minStake, "MatchEscrow: stake below floor");
        require(session0 != address(0), "MatchEscrow: session zero");

        matchId = nextMatchId++;
        Match storage m = matches[matchId];
        m.token = token;
        m.stake = stake;
        m.player0 = msg.sender;
        m.session0 = session0;
        m.status = Status.Open;
        m.rakeBps = rakeBps; // snapshot: a later setRake cannot change this match's terms
        // an Open table nobody joins must never lock the stake forever: past
        // this deadline ANYONE (a keeper) can refund the creator via voidExpired
        m.activeDeadline = uint64(block.timestamp) + openTtl;

        IERC20(token).safeTransferFrom(msg.sender, address(this), stake);
        emit MatchCreated(matchId, msg.sender, token, stake);
    }

    /// @notice Join an open match, locking the matching stake and session key.
    ///         Invite-locked matches cannot be joined here — the seat belongs to
    ///         whoever holds the link's code ({joinMatchWithCode}).
    function joinMatch(uint256 matchId, address session1) external nonReentrant {
        require(inviteHash[matchId] == bytes32(0), "MatchEscrow: invite only");
        _join(matchId, session1);
    }

    /// @notice Take the reserved seat of an invite-locked match by presenting
    ///         the link's secret code.
    /// @dev The code is revealed on-chain at join time. On Celo's sequenced L2
    ///      there is no public mempool to snipe it from, and after this call the
    ///      match is Active — the hash is single-use by construction.
    function joinMatchWithCode(uint256 matchId, address session1, bytes32 code) external nonReentrant {
        bytes32 h = inviteHash[matchId];
        require(h != bytes32(0), "MatchEscrow: not invite-locked");
        require(keccak256(abi.encodePacked(code)) == h, "MatchEscrow: bad invite code");
        _join(matchId, session1);
    }

    function _join(uint256 matchId, address session1) internal {
        Match storage m = matches[matchId];
        require(m.status == Status.Open, "MatchEscrow: not open");
        require(msg.sender != m.player0, "MatchEscrow: self-join");
        require(session1 != address(0) && session1 != m.session0, "MatchEscrow: bad session");

        m.player1 = msg.sender;
        m.session1 = session1;
        m.status = Status.Active;
        m.activeDeadline = uint64(block.timestamp) + matchTtl;
        m.challengeWindow = challengeWindow; // snapshot: a later setChallengeWindow cannot affect this match
        // Defer the first-move flip to a future block's hash. The joiner cannot
        // know blockhash(revealBlock) now, so they cannot grind it; finalizeStart
        // fixes it once that block is mined.
        m.startTurn = START_UNSET;
        m.revealBlock = uint64(block.number) + START_REVEAL_DELAY;

        IERC20(m.token).safeTransferFrom(msg.sender, address(this), m.stake);
        emit MatchJoined(matchId, msg.sender, m.revealBlock);
    }

    /// @notice Fix a joined match's first mover from the reveal block's hash.
    ///         Permissionless and idempotent: callable by a keeper, either
    ///         player, or anyone. If the reveal block has aged out of the
    ///         256-block window before this runs, it re-rolls to a fresh future
    ///         block so a match can never get stuck unable to start.
    function finalizeStart(uint256 matchId) external {
        Match storage m = matches[matchId];
        require(m.status == Status.Active, "MatchEscrow: not active");
        require(m.startTurn == START_UNSET, "MatchEscrow: start fixed");
        require(block.number > m.revealBlock, "MatchEscrow: too early");

        bytes32 bh = blockhash(m.revealBlock);
        if (bh == bytes32(0)) {
            // reveal block out of range (no keeper ran within 256 blocks): re-roll
            m.revealBlock = uint64(block.number) + START_REVEAL_DELAY;
            return;
        }
        uint8 start = uint8(uint256(keccak256(abi.encode(bh, matchId))) & 1);
        m.startTurn = start;
        emit StartFinalized(matchId, start);
    }

    /// @notice Withdraw an open match that no one has joined; refunds the creator.
    function cancelMatch(uint256 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == Status.Open, "MatchEscrow: not open");
        require(msg.sender == m.player0, "MatchEscrow: not creator");

        m.status = Status.Cancelled;
        IERC20(m.token).safeTransfer(m.player0, m.stake);
        emit MatchCancelled(matchId);
    }

    // --------------------------- settlement ----------------------------- //

    /// @notice Happy path: settle a match both players agreed on. Both session
    ///         keys must have signed the result, so it cannot be forged and no
    ///         challenge window is needed.
    function settleSigned(uint256 matchId, uint8 winner, bytes calldata sig0, bytes calldata sig1)
        external
        nonReentrant
    {
        Match storage m = matches[matchId];
        require(m.status == Status.Active, "MatchEscrow: not active");
        require(winner <= DRAW, "MatchEscrow: bad winner");

        bytes32 digest = resultDigest(matchId, winner);
        require(ECDSA.recover(digest, sig0) == m.session0, "MatchEscrow: bad sig0");
        require(ECDSA.recover(digest, sig1) == m.session1, "MatchEscrow: bad sig1");

        _payout(matchId, m, winner);
    }

    /// @notice Refusal-to-sign path: the game FINISHED but the loser won't
    ///         co-sign the result, so the winner submits the full signed
    ///         transcript and the contract replays it on-chain to fix the
    ///         canonical winner, opening the challenge window.
    /// @dev    The winner is PROVEN, never asserted: {verify} recomputes the
    ///         result from both session keys' per-ply signatures, so a
    ///         participant cannot claim a win they did not earn. Critically the
    ///         transcript MUST be terminal — a non-terminal (unfinished) game
    ///         has no winner, so an abandoned match can never be settled to a
    ///         payout here; it refunds both stakes through {voidExpired} after
    ///         the TTL. This removes the prior attacker-controlled `commitment`
    ///         that let a losing/abandoning player fake a win and steal the pot.
    function proposeResult(uint256 matchId, ReplayVerifier.Transcript calldata t) external {
        Match storage m = matches[matchId];
        require(m.status == Status.Active, "MatchEscrow: not active");
        require(block.timestamp <= m.activeDeadline, "MatchEscrow: match expired");
        require(msg.sender == m.player0 || msg.sender == m.player1, "MatchEscrow: not a player");
        // a game cannot have a result before its first move is fixed; this also
        // guarantees the transcript's `t.startTurn == m.startTurn` is meaningful
        require(m.startTurn != START_UNSET, "MatchEscrow: start not finalized");

        // the transcript must belong to exactly this match
        require(t.matchId == matchId, "MatchEscrow: wrong match");
        require(t.session0 == m.session0 && t.session1 == m.session1, "MatchEscrow: session mismatch");
        require(t.startTurn == m.startTurn, "MatchEscrow: startTurn mismatch");

        // replay on-chain: the winner is whatever the rules say, not what the
        // proposer claims. A non-terminal game has no winner and cannot be
        // proposed — abandonment is refunded via voidExpired, never paid out.
        AwaleRules.GameState memory state = verifier.verify(t);
        require(state.over, "MatchEscrow: game not over");

        m.proposedWinner = state.winner;
        m.status = Status.Proposed;
        m.challengeDeadline = uint64(block.timestamp) + m.challengeWindow;
        emit ResultProposed(matchId, state.winner, m.challengeDeadline);
    }

    /// @notice Settle a proposed result immediately by replaying the canonical
    ///         terminal transcript on-chain, without waiting out the window.
    /// @dev PERMISSIONLESS by design: a terminal transcript carries both session
    ///      keys' signatures on every move, so it can only ever *enforce the true
    ///      result* — anyone (in practice the server's keeper) may submit it. The
    ///      proposed winner is already proven in {proposeResult}, so this is a
    ///      liveness convenience (skip the challenge window) and a keeper backstop,
    ///      never a way to overturn a valid claim. There is no longer any
    ///      "non-terminal void" branch: an unfinished game has no winner and is
    ///      never in Proposed status — it refunds via {voidExpired}. This removes
    ///      the proposer-controlled commitment that gated the old void defense.
    function challenge(uint256 matchId, ReplayVerifier.Transcript calldata t) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == Status.Proposed, "MatchEscrow: not proposed");
        require(block.timestamp <= m.challengeDeadline, "MatchEscrow: window closed");

        // the transcript must belong to exactly this match
        require(t.matchId == matchId, "MatchEscrow: wrong match");
        require(t.session0 == m.session0 && t.session1 == m.session1, "MatchEscrow: session mismatch");
        require(t.startTurn == m.startTurn, "MatchEscrow: startTurn mismatch");

        // only a terminal transcript can settle: the verifier's winner is
        // canonical and is paid regardless of the (already-proven) proposed
        // winner. A non-terminal transcript proves nothing here and reverts.
        AwaleRules.GameState memory state = verifier.verify(t);
        require(state.over, "MatchEscrow: game not over");

        emit ResultChallenged(matchId, state.winner);
        _payout(matchId, m, state.winner);
    }

    /// @notice Pay the proposed winner once the challenge window has elapsed.
    function finalize(uint256 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == Status.Proposed, "MatchEscrow: not proposed");
        require(block.timestamp > m.challengeDeadline, "MatchEscrow: window open");

        _payout(matchId, m, m.proposedWinner);
    }

    /// @notice Reclaim stakes from a match that was joined but never settled.
    ///         Callable by either player once the match TTL has elapsed; refunds
    ///         both so funds can never be locked forever by a silent opponent.
    /// @dev    Deliberately NOT for Proposed matches (audit M1): a proposed
    ///         result always has a settlement path forward — {challenge} while
    ///         the window is open, {finalize} (permissionless, no deadline)
    ///         after it closes — so a Proposed match can never be stuck. Voiding
    ///         it would let a losing player erase a legitimate claim after the
    ///         TTL and walk away with a refund instead of their loss.
    /// @dev Permissionless: an expired match is stuck money, and the players
    ///      may be exactly the ones who can no longer act (lost device, lost
    ///      keys). Anyone — in practice the server's keeper — may trigger the
    ///      refund; funds only ever return to the players themselves. Expired
    ///      Open matches (nobody ever joined) refund the creator the same way.
    function voidExpired(uint256 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == Status.Open || m.status == Status.Active, "MatchEscrow: not voidable");
        require(m.activeDeadline != 0 && block.timestamp > m.activeDeadline, "MatchEscrow: not expired");

        if (m.status == Status.Open) {
            // nobody joined — same effect as the creator cancelling themselves
            m.status = Status.Cancelled;
            IERC20(m.token).safeTransfer(m.player0, m.stake);
            emit MatchCancelled(matchId);
            return;
        }
        _void(matchId, m);
    }

    // --------------------------- forfeit clock -------------------------- //

    /// @notice Move-clock forfeit: prove it is the OPPONENT's turn at a valid,
    ///         still-live point and open an on-chain response window. If the
    ///         opponent doesn't answer in time, they abandoned → the claimant
    ///         wins the pot.
    /// @dev This is the deterrent that makes abandonment cost the pot in a cash
    ///      game. A claim can only ever accuse the opponent (never yourself), and
    ///      the opponent can always {rebutForfeit} by making their next legal
    ///      move — so an abandoner's only exits are "keep playing (and lose for
    ///      real)" or "forfeit the pot". A refund is impossible while a forfeit is
    ///      pending: {voidExpired} rejects ForfeitPending.
    /// @param ackSig the ACCUSED's session-key signature over
    ///      verifier.ackDigest(matchId, t.moves.length, stateHash(state)) — proof
    ///      the accused acknowledged it is their turn at this exact position. This
    ///      is the anti-fabrication anchor: a claimant cannot forge or fabricate
    ///      it, so they cannot equivocate on their own move to invent an
    ///      "opponent-to-move" position the opponent never saw (re-audit critical).
    ///      A never-started game (no moves / no ack) refunds via the TTL.
    function proposeForfeit(uint256 matchId, ReplayVerifier.Transcript calldata t, bytes calldata ackSig) external {
        Match storage m = matches[matchId];
        require(m.status == Status.Active, "MatchEscrow: not active");
        require(block.timestamp <= m.activeDeadline, "MatchEscrow: match expired");
        require(m.startTurn != START_UNSET, "MatchEscrow: start not finalized");
        require(t.matchId == matchId, "MatchEscrow: wrong match");
        require(t.session0 == m.session0 && t.session1 == m.session1, "MatchEscrow: session mismatch");
        require(t.startTurn == m.startTurn, "MatchEscrow: startTurn mismatch");

        // replay the prefix: it must be a valid, still-live game. Because moves
        // are session-signed AND bound to their exact position, the claimant
        // cannot fabricate or splice the opponent's moves into a false line.
        AwaleRules.GameState memory state = verifier.verify(t);
        require(!state.over, "MatchEscrow: game over");

        address accused = state.turn == 0 ? m.player0 : m.player1;
        require(msg.sender == m.player0 || msg.sender == m.player1, "MatchEscrow: not a player");
        require(msg.sender != accused, "MatchEscrow: cannot forfeit your own turn");

        // a forfeit must sit strictly past the last answered ply, so a stale
        // claim can't be re-spammed after a rebuttal (forfeit ply tracks real progress)
        require(t.moves.length > m.lastRebuttedPly, "MatchEscrow: stale forfeit ply");

        // ANTI-FABRICATION: the accused must have acknowledged it is their turn at
        // this exact position. A claimant holds only their OWN session key, so a
        // forked/withheld move yields a state the accused never acked — no valid
        // ackSig — and the forfeit reverts. This is what closes the own-move
        // equivocation theft: you cannot invent the opponent's turn.
        address accusedSession = state.turn == 0 ? m.session0 : m.session1;
        bytes32 ackDigest = verifier.ackDigest(matchId, t.moves.length, verifier.stateHash(state));
        require(ECDSA.recover(ackDigest, ackSig) == accusedSession, "MatchEscrow: missing turn ack");

        m.forfeitPrefix = verifier.transcriptHash(matchId, m.startTurn, t.moves);
        m.forfeitPly = uint32(t.moves.length);
        m.proposedWinner = msg.sender == m.player0 ? 0 : 1; // claimant wins if unanswered
        m.status = Status.ForfeitPending;
        m.challengeDeadline = uint64(block.timestamp) + m.challengeWindow;
        emit ForfeitProposed(matchId, m.proposedWinner, m.forfeitPly, m.challengeDeadline);
    }

    /// @notice Rebut a pending forfeit by supplying the accused's next legal
    ///         signed move — proof of presence. If that move ends the game, the
    ///         canonical winner is paid; otherwise play resumes.
    /// @dev PERMISSIONLESS: a valid signed move can only ever help the accused
    ///      (prove presence / advance the game / settle to the true winner), so
    ///      the server's keeper may submit it on an honest player's behalf.
    function rebutForfeit(uint256 matchId, ReplayVerifier.Transcript calldata t2) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == Status.ForfeitPending, "MatchEscrow: not forfeit-pending");
        require(block.timestamp <= m.challengeDeadline, "MatchEscrow: window closed");
        require(t2.matchId == matchId, "MatchEscrow: wrong match");
        require(t2.session0 == m.session0 && t2.session1 == m.session1, "MatchEscrow: session mismatch");
        require(t2.startTurn == m.startTurn, "MatchEscrow: startTurn mismatch");
        require(t2.moves.length == uint256(m.forfeitPly) + 1, "MatchEscrow: not a one-move rebuttal");
        // the rebuttal must extend the EXACT committed prefix by one move
        require(
            _prefixHash(matchId, m.startTurn, t2.moves, m.forfeitPly) == m.forfeitPrefix,
            "MatchEscrow: prefix mismatch"
        );

        // verify() re-checks every signature (incl. the accused's new move, bound
        // to its exact position) and reverts on any illegal move
        AwaleRules.GameState memory state2 = verifier.verify(t2);
        emit ForfeitRebutted(matchId, m.forfeitPly);
        if (state2.over) {
            // the response ended the game → pay the canonical winner
            _payout(matchId, m, state2.winner);
        } else {
            // presence proven → resume play; refresh the TTL so the resumed game
            // isn't instantly voidable, and raise the anti-replay floor
            m.lastRebuttedPly = m.forfeitPly;
            m.forfeitPrefix = bytes32(0);
            m.forfeitPly = 0;
            m.status = Status.Active;
            m.activeDeadline = uint64(block.timestamp) + matchTtl;
        }
    }

    /// @notice Award the pot to the claimant once the forfeit window elapses with
    ///         no valid rebuttal — the accused abandoned. Permissionless (the
    ///         keeper triggers it, but anyone may).
    function finalizeForfeit(uint256 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == Status.ForfeitPending, "MatchEscrow: not forfeit-pending");
        require(block.timestamp > m.challengeDeadline, "MatchEscrow: window open");
        _payout(matchId, m, m.proposedWinner);
    }

    // ------------------------------ payout ------------------------------ //

    function _payout(uint256 matchId, Match storage m, uint8 winner) internal {
        // checks-effects-interactions: mark resolved before any token transfer
        m.status = Status.Resolved;

        IERC20 token = IERC20(m.token);
        uint256 stake = m.stake;
        uint256 pot = stake * 2;

        if (winner == DRAW) {
            // no rake on a draw; each player simply gets their stake back
            token.safeTransfer(m.player0, stake);
            token.safeTransfer(m.player1, stake);
            emit MatchSettled(matchId, DRAW, stake);
            return;
        }

        uint256 rake = (pot * m.rakeBps) / BPS; // rake snapshotted at creation
        uint256 prize = pot - rake;
        address winnerAddr = winner == 0 ? m.player0 : m.player1;

        token.safeTransfer(winnerAddr, prize);
        if (rake > 0) {
            token.safeTransfer(treasury, rake);
            emit FeeCollected(matchId, m.token, rake);
        }
        emit MatchSettled(matchId, winner, prize);
    }

    /// @dev Refund both stakes in full (no winner, no rake) and close the match.
    function _void(uint256 matchId, Match storage m) internal {
        m.status = Status.Voided;
        IERC20 token = IERC20(m.token);
        uint256 stake = m.stake;
        token.safeTransfer(m.player0, stake);
        token.safeTransfer(m.player1, stake);
        emit MatchVoided(matchId);
    }

    /// @dev keccak of the first `k` moves of `moves`, matching
    ///      {ReplayVerifier.transcriptHash}'s encoding — used to check a forfeit
    ///      rebuttal extends exactly the committed prefix.
    function _prefixHash(uint256 matchId, uint8 startTurn, uint8[] calldata moves, uint32 k)
        internal
        pure
        returns (bytes32)
    {
        uint8[] memory pre = new uint8[](k);
        for (uint256 i = 0; i < k; i++) {
            pre[i] = moves[i];
        }
        return keccak256(abi.encode(matchId, startTurn, pre));
    }

    // ------------------------------ views ------------------------------- //

    /// @notice Full match record (convenience accessor over the public mapping).
    function getMatch(uint256 matchId) external view returns (Match memory) {
        return matches[matchId];
    }

    /// @notice EIP-712 digest a session key signs to attest the agreed result.
    function resultDigest(uint256 matchId, uint8 winner) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(RESULT_TYPEHASH, matchId, winner));
        return MessageHashUtils.toTypedDataHash(DOMAIN_SEPARATOR, structHash);
    }

    // ------------------------------ admin ------------------------------- //

    function setRake(uint16 rakeBps_) external onlyOwner {
        require(rakeBps_ <= MAX_RAKE_BPS, "MatchEscrow: rake too high");
        rakeBps = rakeBps_;
        emit RakeUpdated(rakeBps_);
    }

    /// @notice Set the minimum per-player stake. Only gates new matches; in-flight
    ///         matches keep their terms. 0 disables the floor.
    function setMinStake(uint128 minStake_) external onlyOwner {
        minStake = minStake_;
        emit MinStakeUpdated(minStake_);
    }

    function setChallengeWindow(uint64 challengeWindow_) external onlyOwner {
        require(challengeWindow_ >= MIN_CHALLENGE_WINDOW, "MatchEscrow: window too short");
        challengeWindow = challengeWindow_;
        emit ChallengeWindowUpdated(challengeWindow_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "MatchEscrow: treasury zero");
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setMatchTtl(uint64 matchTtl_) external onlyOwner {
        matchTtl = matchTtl_;
        emit MatchTtlUpdated(matchTtl_);
    }

    function setOpenTtl(uint64 openTtl_) external onlyOwner {
        openTtl = openTtl_;
        emit OpenTtlUpdated(openTtl_);
    }

    /// @notice Allow or disallow a stablecoin for staking. Restricting to
    ///         audited, non-rebasing, non-fee-on-transfer tokens keeps escrow
    ///         accounting exact.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }
}
