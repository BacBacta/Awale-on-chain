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
        Resolved, // paid out
        Cancelled // open match withdrawn before anyone joined

    }

    struct Match {
        address token; // staked ERC20 stablecoin
        uint128 stake; // per-player stake, in token units
        address player0; // creator (South / AwaleRules player 0)
        address player1; // joiner (North / AwaleRules player 1)
        address session0; // player 0's per-match session key (ephemeral address)
        address session1; // player 1's per-match session key
        Status status;
        uint8 startTurn; // committed first mover (0 or 1)
        uint8 proposedWinner; // 0, 1, or DRAW — valid while Proposed
        uint64 challengeDeadline; // timestamp the challenge window closes
    }

    uint16 public constant MAX_RAKE_BPS = 1000; // hard cap: rake can never exceed 10%
    uint16 public constant BPS = 10_000;
    uint8 internal constant DRAW = 2;

    ReplayVerifier public immutable verifier;
    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant RESULT_TYPEHASH = keccak256("Result(uint256 matchId,uint8 winner)");

    address public treasury;
    uint16 public rakeBps;
    uint64 public challengeWindow;

    uint256 public nextMatchId = 1;
    mapping(uint256 => Match) public matches;

    event MatchCreated(uint256 indexed matchId, address indexed player0, address token, uint128 stake);
    event MatchJoined(uint256 indexed matchId, address indexed player1, uint8 startTurn);
    event MatchCancelled(uint256 indexed matchId);
    event ResultProposed(uint256 indexed matchId, uint8 winner, uint64 challengeDeadline);
    event ResultChallenged(uint256 indexed matchId, uint8 canonicalWinner);
    event MatchSettled(uint256 indexed matchId, uint8 winner, uint256 prize);
    event FeeCollected(uint256 indexed matchId, address indexed token, uint256 amount);

    event RakeUpdated(uint16 rakeBps);
    event ChallengeWindowUpdated(uint64 challengeWindow);
    event TreasuryUpdated(address treasury);

    constructor(
        address verifier_,
        address treasury_,
        uint16 rakeBps_,
        uint64 challengeWindow_,
        address owner_
    ) Ownable(owner_) {
        require(verifier_ != address(0), "MatchEscrow: verifier zero");
        require(treasury_ != address(0), "MatchEscrow: treasury zero");
        require(rakeBps_ <= MAX_RAKE_BPS, "MatchEscrow: rake too high");
        verifier = ReplayVerifier(verifier_);
        treasury = treasury_;
        rakeBps = rakeBps_;
        challengeWindow = challengeWindow_;

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("AwaleMatchEscrow"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    // ----------------------------- funding ------------------------------ //

    /// @notice Create an open match, locking the creator's stake and session key.
    function createMatch(address token, uint128 stake, address session0)
        external
        nonReentrant
        returns (uint256 matchId)
    {
        require(token != address(0), "MatchEscrow: token zero");
        require(stake > 0, "MatchEscrow: stake zero");
        require(session0 != address(0), "MatchEscrow: session zero");

        matchId = nextMatchId++;
        Match storage m = matches[matchId];
        m.token = token;
        m.stake = stake;
        m.player0 = msg.sender;
        m.session0 = session0;
        m.status = Status.Open;

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
        // v1 randomness for the first mover; replace with VRF before mainnet (§6).
        m.startTurn = uint8(uint256(keccak256(abi.encode(block.prevrandao, matchId, m.player0, msg.sender))) & 1);

        IERC20(m.token).safeTransferFrom(msg.sender, address(this), m.stake);
        emit MatchJoined(matchId, msg.sender, m.startTurn);
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
    function proposeResult(uint256 matchId, uint8 winner) external {
        Match storage m = matches[matchId];
        require(m.status == Status.Active, "MatchEscrow: not active");
        require(msg.sender == m.player0 || msg.sender == m.player1, "MatchEscrow: not a player");
        require(winner <= DRAW, "MatchEscrow: bad winner");

        m.proposedWinner = winner;
        m.status = Status.Proposed;
        m.challengeDeadline = uint64(block.timestamp) + challengeWindow;
        emit ResultProposed(matchId, winner, m.challengeDeadline);
    }

    /// @notice Overturn (or confirm) a proposed result by replaying the full
    ///         signed transcript on-chain. The verifier's terminal winner is
    ///         canonical and is paid immediately.
    function challenge(uint256 matchId, ReplayVerifier.Transcript calldata t) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == Status.Proposed, "MatchEscrow: not proposed");
        require(block.timestamp <= m.challengeDeadline, "MatchEscrow: window closed");

        // the transcript must belong to exactly this match
        require(t.matchId == matchId, "MatchEscrow: wrong match");
        require(t.session0 == m.session0 && t.session1 == m.session1, "MatchEscrow: session mismatch");
        require(t.startTurn == m.startTurn, "MatchEscrow: startTurn mismatch");

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

        uint256 rake = (pot * rakeBps) / BPS;
        uint256 prize = pot - rake;
        address winnerAddr = winner == 0 ? m.player0 : m.player1;

        token.safeTransfer(winnerAddr, prize);
        if (rake > 0) {
            token.safeTransfer(treasury, rake);
            emit FeeCollected(matchId, m.token, rake);
        }
        emit MatchSettled(matchId, winner, prize);
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
        challengeWindow = challengeWindow_;
        emit ChallengeWindowUpdated(challengeWindow_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "MatchEscrow: treasury zero");
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }
}
