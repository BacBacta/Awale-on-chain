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
        uint8 startTurn; // first mover (0 or 1); START_UNSET until the reveal block is mined
        uint8 proposedWinner; // 0, 1, or DRAW — valid while Proposed
        uint16 rakeBps; // rake snapshotted at creation (owner cannot change it mid-match)
        uint64 challengeDeadline; // timestamp the challenge window closes
        uint64 activeDeadline; // timestamp after which an unsettled Active match can be voided
        uint64 revealBlock; // block whose hash fixes startTurn (set at join, unknown to the joiner)
        uint64 challengeWindow; // window duration snapshotted at join (owner cannot change mid-match)
        bytes32 transcriptCommitment; // keccak hash of the proposer's game transcript (set at proposeResult)
    }

    uint16 public constant MAX_RAKE_BPS = 1000; // hard cap: rake can never exceed 10%
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

    uint256 public nextMatchId = 1;
    mapping(uint256 => Match) public matches;
    mapping(address => bool) public allowedToken; // only audited stablecoins may be staked

    event MatchCreated(uint256 indexed matchId, address indexed player0, address token, uint128 stake);
    event MatchJoined(uint256 indexed matchId, address indexed player1, uint64 revealBlock);
    event StartFinalized(uint256 indexed matchId, uint8 startTurn);
    event MatchCancelled(uint256 indexed matchId);
    event MatchVoided(uint256 indexed matchId);
    event ResultProposed(uint256 indexed matchId, uint8 winner, uint64 challengeDeadline);
    event ResultChallenged(uint256 indexed matchId, uint8 canonicalWinner);
    event MatchSettled(uint256 indexed matchId, uint8 winner, uint256 prize);
    event FeeCollected(uint256 indexed matchId, address indexed token, uint256 amount);

    event RakeUpdated(uint16 rakeBps);
    event ChallengeWindowUpdated(uint64 challengeWindow);
    event MatchTtlUpdated(uint64 matchTtl);
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
        require(allowedToken[token], "MatchEscrow: token not allowed");
        require(stake > 0, "MatchEscrow: stake zero");
        require(session0 != address(0), "MatchEscrow: session zero");

        matchId = nextMatchId++;
        Match storage m = matches[matchId];
        m.token = token;
        m.stake = stake;
        m.player0 = msg.sender;
        m.session0 = session0;
        m.status = Status.Open;
        m.rakeBps = rakeBps; // snapshot: a later setRake cannot change this match's terms

        IERC20(token).safeTransferFrom(msg.sender, address(this), stake);
        emit MatchCreated(matchId, msg.sender, token, stake);
    }

    /// @notice Join an open match, locking the matching stake and session key.
    function joinMatch(uint256 matchId, address session1) external nonReentrant {
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
        require(msg.sender == m.player0 || msg.sender == m.player1, "MatchEscrow: not a player");
        require(m.status == Status.Proposed, "MatchEscrow: not proposed");
        require(block.timestamp <= m.challengeDeadline, "MatchEscrow: window closed");

        // the transcript must belong to exactly this match
        require(t.matchId == matchId, "MatchEscrow: wrong match");
        require(t.session0 == m.session0 && t.session1 == m.session1, "MatchEscrow: session mismatch");
        require(t.startTurn == m.startTurn, "MatchEscrow: startTurn mismatch");

        AwaleRules.GameState memory state = verifier.verify(t);

        if (state.over) {
            // terminal: canonical winner is paid regardless of the proposer's claim
            emit ResultChallenged(matchId, state.winner);
            _payout(matchId, m, state.winner);
        } else {
            // non-terminal: only void if the transcript matches the proposer's commitment.
            // Requiring the hash prevents a losing challenger from submitting a short
            // prefix of the real game to manufacture a false "game-still-live" proof.
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
    /// @dev    Also accepts Proposed status: if the challenge window overlaps the
    ///         TTL expiry, the match may be Proposed-but-expired. Allowing voidExpired
    ///         here ensures neither player is permanently locked out of a refund.
    function voidExpired(uint256 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == Status.Active || m.status == Status.Proposed, "MatchEscrow: not active or proposed");
        require(msg.sender == m.player0 || msg.sender == m.player1, "MatchEscrow: not a player");
        require(block.timestamp > m.activeDeadline, "MatchEscrow: not expired");

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

    /// @notice Allow or disallow a stablecoin for staking. Restricting to
    ///         audited, non-rebasing, non-fee-on-transfer tokens keeps escrow
    ///         accounting exact.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }
}
