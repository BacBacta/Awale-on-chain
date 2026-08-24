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
        Voided // refunded to both players (premature proposal or expiry)
    }

    struct Match {
        address token; // staked ERC20 stablecoin
        uint128 stake; // per-player stake, in token units
        address player0; // creator (South / AwaleRules player 0)
        address player1; // joiner (North / AwaleRules player 1)
        address session0; // player 0's per-match session key (ephemeral address)
        address session1; // player 1's per-match session key
        Status status;
        uint8 startTurn; // first mover (0 or 1); START_UNSET until both secrets are revealed
        uint8 proposedWinner; // 0, 1, or DRAW — valid while Proposed
        uint16 rakeBps; // rake snapshotted at creation (owner cannot change it mid-match)
        uint64 challengeDeadline; // timestamp the challenge window closes
        uint64 activeDeadline; // timestamp after which an unsettled Active match can be voided
        uint64 challengeWindow; // window duration snapshotted at join (owner cannot change mid-match)
        bytes32 commit0; // keccak256(secret0) — creator's first-move commitment
        bytes32 commit1; // keccak256(secret1) — joiner's, made blind to secret0
        bytes32 transcriptCommitment; // keccak hash of the proposer's game transcript (set at proposeResult)
    }

    uint16 public constant MAX_RAKE_BPS = 2000; // hard cap: rake can never exceed 20%
    uint16 public constant BPS = 10_000;
    uint8 internal constant DRAW = 2;
    uint64 public constant MIN_CHALLENGE_WINDOW = 5 minutes; // owner cannot set below this

    // First-move randomness: a two-party commit–reveal. Each player commits to a
    // secret in the transaction they already send (create / join) and the flip is
    // keccak(secret0, secret1, matchId) — so neither side can bias it: player 0
    // commits before player 1 exists, and player 1 commits without ever seeing
    // secret0, so no choice of secret1 steers the result.
    //
    // This deliberately replaces a future-blockhash flip. On Celo (~1s blocks)
    // the EVM's 256-block blockhash window is only ~4 minutes, and the outcome
    // becomes publicly computable the moment the reveal block is mined but is
    // only committed when someone calls finalizeStart. That gap let whichever
    // player disliked the pending result stall past the window for a FREE
    // re-roll, indefinitely, and left the flip dependent on keeper liveness.
    // A commitment fixes the result before anyone can see it, so stalling wins
    // nothing and no window can expire. It also removes the sequencer's
    // influence: no block hash enters the derivation at all.
    //
    // Residual, accepted — and it is a LIVENESS cost, not a fairness one:
    //
    // No player can condition their reveal on the result. Each sends its half
    // to the server and never receives the other's, so the outcome is not
    // computable by either of them until the flip is already fixed on chain.
    // Withholding is therefore blind: it cannot buy a better start.
    //
    // What it does buy is a stall. Because {proposeResult} requires the first
    // move to be fixed, a match that never starts has no forfeit path — the
    // only exit is {voidExpired} at the TTL, which refunds BOTH players. So a
    // joiner who changes their mind can force a guaranteed refund and tie up
    // the creator's stake for matchTtl, where an abandonment AFTER the start
    // would have cost them the match. The griefer pays the same TTL on their
    // own stake and gains nothing, so this is a nuisance rather than an edge,
    // but shortening matchTtl is the lever if it is ever abused in practice.
    //
    // Secrets MUST be freshly random per match. Reusing one across matches
    // reveals it, and an opponent who knows secret0 can grind secret1.
    // START_UNSET marks a match whose flip is not yet fixed.
    uint8 internal constant START_UNSET = type(uint8).max;

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
    /// @notice Minimum per-player stake, keyed BY TOKEN and denominated in that
    ///         token's own units. Must be per-token: the allowlist deliberately
    ///         mixes 18-dec (USDm) with 6-dec (USDC/USDT), so a single global
    ///         floor cannot mean the same thing twice — a value that gates USDC
    ///         sensibly is ~1e-13 of a USDm (no floor at all), while one that
    ///         gates USDm would demand hundreds of billions of USDC (staking
    ///         that token bricked outright). 0 ⇒ no floor for that token.
    mapping(address => uint128) public minStake;

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
    event MatchJoined(uint256 indexed matchId, address indexed player1);
    event StartFinalized(uint256 indexed matchId, uint8 startTurn);
    event MatchCancelled(uint256 indexed matchId);
    event MatchVoided(uint256 indexed matchId);
    event ResultProposed(uint256 indexed matchId, uint8 winner, uint64 challengeDeadline);
    event ResultChallenged(uint256 indexed matchId, uint8 canonicalWinner);
    event MatchSettled(uint256 indexed matchId, uint8 winner, uint256 prize);
    event FeeCollected(uint256 indexed matchId, address indexed token, uint256 amount);

    event RakeUpdated(uint16 rakeBps);
    event MinStakeUpdated(address indexed token, uint128 minStake);
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
    /// @param commit0 keccak256(abi.encode(secret0)) — the creator's half of the
    ///        first-move flip. Must be a FRESH random 32 bytes per match.
    function createMatch(address token, uint128 stake, address session0, bytes32 commit0)
        external
        nonReentrant
        returns (uint256 matchId)
    {
        matchId = _create(token, stake, session0, commit0);
    }

    /// @notice Create a stake match reserved for a FRIEND: only someone who can
    ///         present `code` with keccak256(abi.encodePacked(code)) ==
    ///         `inviteHash_` may take the seat (the code travels in the invite
    ///         link, off-chain). Everything else — rake, session keys,
    ///         settlement, cancel, TTL refunds — is identical to an open match.
    function createMatchWithInvite(address token, uint128 stake, address session0, bytes32 commit0, bytes32 inviteHash_)
        external
        nonReentrant
        returns (uint256 matchId)
    {
        require(inviteHash_ != bytes32(0), "MatchEscrow: empty invite");
        matchId = _create(token, stake, session0, commit0);
        inviteHash[matchId] = inviteHash_;
        emit MatchInviteLocked(matchId);
    }

    function _create(address token, uint128 stake, address session0, bytes32 commit0)
        internal
        returns (uint256 matchId)
    {
        require(allowedToken[token], "MatchEscrow: token not allowed");
        require(commit0 != bytes32(0), "MatchEscrow: empty commit");
        require(stake > 0, "MatchEscrow: stake zero");
        // a stake floor kills dust matches whose rake rounds to ~0 yet still cost
        // gas + infra to settle (negative-margin); 0 disables the floor. Read
        // per-token so the threshold is the same real value in every stablecoin.
        require(stake >= minStake[token], "MatchEscrow: stake below floor");
        require(session0 != address(0), "MatchEscrow: session zero");

        matchId = nextMatchId++;
        Match storage m = matches[matchId];
        m.token = token;
        m.stake = stake;
        m.player0 = msg.sender;
        m.session0 = session0;
        m.commit0 = commit0;
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
    /// @param commit1 keccak256(abi.encode(secret1)) — the joiner's half of the
    ///        first-move flip, chosen blind to secret0. Fresh random 32 bytes.
    function joinMatch(uint256 matchId, address session1, bytes32 commit1) external nonReentrant {
        require(inviteHash[matchId] == bytes32(0), "MatchEscrow: invite only");
        _join(matchId, session1, commit1);
    }

    /// @notice Take the reserved seat of an invite-locked match by presenting
    ///         the link's secret code.
    /// @dev The code is revealed on-chain at join time. On Celo's sequenced L2
    ///      there is no public mempool to snipe it from, and after this call the
    ///      match is Active — the hash is single-use by construction.
    function joinMatchWithCode(uint256 matchId, address session1, bytes32 commit1, bytes32 code)
        external
        nonReentrant
    {
        bytes32 h = inviteHash[matchId];
        require(h != bytes32(0), "MatchEscrow: not invite-locked");
        require(keccak256(abi.encodePacked(code)) == h, "MatchEscrow: bad invite code");
        _join(matchId, session1, commit1);
    }

    function _join(uint256 matchId, address session1, bytes32 commit1) internal {
        Match storage m = matches[matchId];
        require(m.status == Status.Open, "MatchEscrow: not open");
        require(msg.sender != m.player0, "MatchEscrow: self-join");
        require(session1 != address(0) && session1 != m.session0, "MatchEscrow: bad session");
        require(commit1 != bytes32(0), "MatchEscrow: empty commit");
        // copying the creator's commitment would leave the joiner unable to ever
        // reveal (they don't know secret0), deadlocking the match into a refund
        require(commit1 != m.commit0, "MatchEscrow: duplicate commit");

        m.player1 = msg.sender;
        m.session1 = session1;
        m.commit1 = commit1;
        m.status = Status.Active;
        m.activeDeadline = uint64(block.timestamp) + matchTtl;
        m.challengeWindow = challengeWindow; // snapshot: a later setChallengeWindow cannot affect this match
        // both halves of the flip are now committed and neither is public;
        // {finalizeStart} fixes the result as soon as the pair is revealed
        m.startTurn = START_UNSET;

        IERC20(m.token).safeTransferFrom(msg.sender, address(this), m.stake);
        emit MatchJoined(matchId, msg.sender);
    }

    /// @notice Fix a joined match's first mover by revealing BOTH commitments.
    ///         Permissionless: anyone holding the pair may call — in practice
    ///         the server, which collects a reveal from each player, but either
    ///         player can do it themselves if the server is gone.
    /// @dev No deadline and no expiry. The result is determined the moment both
    ///      commitments exist (at join), so there is nothing to race and no
    ///      window to miss; the reveal only makes it computable. Calling with a
    ///      wrong preimage reverts rather than re-rolling, so there is no path
    ///      that hands anybody a second draw.
    function finalizeStart(uint256 matchId, bytes32 secret0, bytes32 secret1) external {
        Match storage m = matches[matchId];
        require(m.status == Status.Active, "MatchEscrow: not active");
        require(m.startTurn == START_UNSET, "MatchEscrow: start fixed");
        require(keccak256(abi.encode(secret0)) == m.commit0, "MatchEscrow: bad secret0");
        require(keccak256(abi.encode(secret1)) == m.commit1, "MatchEscrow: bad secret1");

        // matchId is folded in so the same secret pair cannot produce a
        // correlated result across two matches
        uint8 start = uint8(uint256(keccak256(abi.encode(secret0, secret1, matchId))) & 1);
        m.startTurn = start;
        emit StartFinalized(matchId, start);
    }

    /// @notice The commitment to publish for `secret` — exposed so a client can
    ///         never disagree with the contract about the hashing.
    function commitmentOf(bytes32 secret) external pure returns (bytes32) {
        return keccak256(abi.encode(secret));
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

    /// @notice Abandonment / refusal path: a participant claims the result and
    ///         opens the challenge window. If the claim is false, the opponent
    ///         overturns it with {challenge}; otherwise {finalize} pays out.
    /// @param commitment  verifier.transcriptHash(matchId, startTurn, allMoves) — the
    ///                    proposer binds to the specific move sequence they witnessed.
    ///                    A challenger who disputes with a *non-terminal* transcript
    ///                    must produce one that hashes to this exact value; submitting
    ///                    a different (e.g., partial) transcript reverts instead of
    ///                    voiding. This closes the partial-transcript escape attack.
    function proposeResult(uint256 matchId, uint8 winner, bytes32 commitment) external {
        Match storage m = matches[matchId];
        require(m.status == Status.Active, "MatchEscrow: not active");
        require(block.timestamp <= m.activeDeadline, "MatchEscrow: match expired");
        require(msg.sender == m.player0 || msg.sender == m.player1, "MatchEscrow: not a player");
        require(winner <= DRAW, "MatchEscrow: bad winner");
        require(commitment != bytes32(0), "MatchEscrow: zero commitment");
        // a game cannot have a result before its first move is fixed; this also
        // guarantees {challenge}'s `t.startTurn == m.startTurn` is meaningful
        require(m.startTurn != START_UNSET, "MatchEscrow: start not finalized");

        m.proposedWinner = winner;
        m.transcriptCommitment = commitment;
        m.status = Status.Proposed;
        m.challengeDeadline = uint64(block.timestamp) + m.challengeWindow;
        emit ResultProposed(matchId, winner, m.challengeDeadline);
    }

    /// @notice Overturn (or confirm) a proposed result by replaying the full
    ///         signed transcript on-chain.
    /// @dev Two outcomes:
    ///        - terminal transcript: the verifier's winner is canonical and
    ///          is paid out, ignoring the proposed winner.
    ///        - non-terminal transcript: the game was still live, so the
    ///          proposal was premature — but only if the transcript hashes to
    ///          the proposer's commitment (prevents escape via partial transcript).
    function challenge(uint256 matchId, ReplayVerifier.Transcript calldata t) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == Status.Proposed, "MatchEscrow: not proposed");
        require(block.timestamp <= m.challengeDeadline, "MatchEscrow: window closed");

        // the transcript must belong to exactly this match
        require(t.matchId == matchId, "MatchEscrow: wrong match");
        require(t.session0 == m.session0 && t.session1 == m.session1, "MatchEscrow: session mismatch");
        require(t.startTurn == m.startTurn, "MatchEscrow: startTurn mismatch");

        AwaleRules.GameState memory state = verifier.verify(t);

        if (state.over) {
            // terminal: the verifier's winner is canonical and is paid regardless
            // of the proposer's claim. PERMISSIONLESS — a terminal transcript,
            // carrying both session signatures, can only *enforce the true
            // result*, so anyone may submit it. This is essential: when the
            // honest winner is offline for the whole window, the server's keeper
            // (never a match player) is the only actor that can refute a losing
            // opponent's false proposeResult+finalize theft. A player-only gate
            // here silently disabled that backstop — and audit L-04 was only ever
            // about the void path below, where an outsider forcing a *refund* is
            // the actual griefing vector.
            emit ResultChallenged(matchId, state.winner);
            _payout(matchId, m, state.winner);
        } else {
            // non-terminal but valid → proves the game was still live, so the
            // proposal was premature → void (refund both). Two gates:
            //   1. participants only — an outsider replaying a validly-signed
            //      partial transcript to force a refund is the L-04 grief; a
            //      third party can never trigger a void.
            //   2. the transcript must hash to the proposer's commitment — stops
            //      a losing challenger submitting a short prefix of the real game
            //      to manufacture a false "game-still-live" proof (H-02).
            require(msg.sender == m.player0 || msg.sender == m.player1, "MatchEscrow: not a player");
            require(
                verifier.transcriptHash(t.matchId, t.startTurn, t.moves) == m.transcriptCommitment,
                "MatchEscrow: transcript mismatch"
            );
            _void(matchId, m);
        }
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

    /// @notice Set the minimum per-player stake for `token`, in THAT token's own
    ///         units — so 5e6 is $5 of USDC and 5e18 is $5 of USDm. Only gates new
    ///         matches; in-flight matches keep their terms. 0 disables the floor.
    function setMinStake(address token, uint128 minStake_) external onlyOwner {
        minStake[token] = minStake_;
        emit MinStakeUpdated(token, minStake_);
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
