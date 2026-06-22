// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TournamentEscrow — entry-fee custody and prize settlement for Awalé Sit-and-Go tournaments
/// @notice Collects each entrant's stablecoin entry fee into a per-tournament prize
///         pool, lets sponsors top it up (for free-rolls), and pays out a fixed
///         payout table to the final standings reported by the protocol operator.
///         The protocol cut is skimmed from the pool at finalize and routed to the
///         Treasury — the same fee sink as {MatchEscrow}.
///
/// @dev Trust model (deliberately simpler than MatchEscrow's per-move replay
///      verification): a single tournament aggregates many bracket matches, so
///      finalising the full bracket trustlessly on-chain is impractical. Instead a
///      trusted `operator` (the protocol's settlement coordinator) submits the
///      ordered winners. The operator's power is tightly bounded:
///        - it can ONLY pay registered entrants (winners must have joined),
///        - the split is the payout table FIXED at creation (operator picks the
///          ordering, never the amounts),
///        - it cannot move funds anywhere but entrants + the Treasury cut,
///        - if it never finalises, anyone can refund every entrant after
///          `refundDeadline`, so funds can never be locked.
///      Individual bracket games remain session-key signed off-chain; this
///      contract is the money layer only.
///
/// @dev All amounts are in the token's own units (18-dec USDm / 6-dec USDC/USDT
///      handled without normalisation). `maxPlayers` is capped so the refund loop
///      is always gas-bounded.
contract TournamentEscrow is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open, // accepting entrants
        Finalized, // prizes paid out
        Cancelled // refunded (under-filled or operator never finalised)
    }

    struct Tournament {
        address token; // staked ERC20 stablecoin
        uint128 entryFee; // per-entrant fee, in token units (0 ⇒ free-roll)
        uint128 prizePool; // entry fees + sponsor funding accumulated so far
        uint128 sponsored; // portion of prizePool from fund() (not refundable to entrants)
        uint32 maxPlayers; // hard cap on entrants
        uint32 playerCount; // entrants so far
        uint16 cutBps; // protocol cut, snapshotted at creation
        Status status;
        uint64 joinDeadline; // entries close; under-filled tournaments refund after this
        uint64 refundDeadline; // if not finalised by here, anyone may refund all entrants
        address creator;
        uint16[] payoutBps; // prize split over the distributable pool; sums to BPS
    }

    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_CUT_BPS = 2000; // hard cap: cut can never exceed 20%
    uint32 public constant MIN_PLAYERS = 2; // below this at joinDeadline ⇒ refund
    uint32 public constant MAX_PLAYERS_CAP = 64; // bounds the refund loop's gas

    address public treasury;
    address public operator; // settlement coordinator that reports standings

    uint256 public nextTournamentId = 1;
    mapping(uint256 => Tournament) internal tournaments;
    mapping(uint256 => mapping(address => bool)) public joined; // entrant set, per tournament
    mapping(uint256 => address[]) internal entrants; // ordered entrants, for refund iteration
    mapping(address => bool) public allowedToken; // only audited stablecoins

    event TournamentCreated(
        uint256 indexed id, address indexed token, uint128 entryFee, uint32 maxPlayers, uint16 cutBps
    );
    event Joined(uint256 indexed id, address indexed player, uint32 playerCount);
    event Funded(uint256 indexed id, address indexed sponsor, uint128 amount);
    event Finalized(uint256 indexed id, address[] winners, uint256 distributed, uint256 cut);
    event Cancelled(uint256 indexed id, uint32 refunded);
    event PrizePaid(uint256 indexed id, address indexed winner, uint256 amount);
    event FeeCollected(uint256 indexed id, address indexed token, uint256 amount);

    event TreasuryUpdated(address indexed treasury);
    event OperatorUpdated(address indexed operator);
    event TokenAllowed(address indexed token, bool allowed);

    modifier onlyOperator() {
        require(msg.sender == operator, "Tournament: not operator");
        _;
    }

    constructor(address treasury_, address operator_, address owner_) Ownable(owner_) {
        require(treasury_ != address(0), "Tournament: treasury zero");
        require(operator_ != address(0), "Tournament: operator zero");
        treasury = treasury_;
        operator = operator_;
    }

    // ----------------------------- lifecycle ---------------------------- //

    /// @notice Open a new tournament. Only the operator creates them (the lobby is
    ///         server-orchestrated), fixing the entry fee, field size, cut, payout
    ///         table and the join/refund deadlines up front.
    /// @param payoutBps  prize split over the distributable pool (pool minus cut);
    ///                   must sum to exactly BPS. e.g. [6500,3500] pays top two.
    function createTournament(
        address token,
        uint128 entryFee,
        uint32 maxPlayers,
        uint16 cutBps,
        uint64 joinWindow,
        uint64 refundWindow,
        uint16[] calldata payoutBps
    ) external onlyOperator returns (uint256 id) {
        require(allowedToken[token], "Tournament: token not allowed");
        require(maxPlayers >= MIN_PLAYERS && maxPlayers <= MAX_PLAYERS_CAP, "Tournament: bad field size");
        require(cutBps <= MAX_CUT_BPS, "Tournament: cut too high");
        require(payoutBps.length > 0 && payoutBps.length <= maxPlayers, "Tournament: bad payout table");
        require(refundWindow > joinWindow, "Tournament: refund before join");

        uint256 sum;
        for (uint256 i = 0; i < payoutBps.length; i++) {
            sum += payoutBps[i];
        }
        require(sum == BPS, "Tournament: payout != 100%");

        id = nextTournamentId++;
        Tournament storage t = tournaments[id];
        t.token = token;
        t.entryFee = entryFee;
        t.maxPlayers = maxPlayers;
        t.cutBps = cutBps;
        t.status = Status.Open;
        t.joinDeadline = uint64(block.timestamp) + joinWindow;
        t.refundDeadline = uint64(block.timestamp) + refundWindow;
        t.creator = msg.sender;
        t.payoutBps = payoutBps;

        emit TournamentCreated(id, token, entryFee, maxPlayers, cutBps);
    }

    /// @notice Enter an open tournament, locking the entry fee into the prize pool.
    function join(uint256 id) external nonReentrant {
        Tournament storage t = tournaments[id];
        require(t.status == Status.Open, "Tournament: not open");
        require(block.timestamp <= t.joinDeadline, "Tournament: entries closed");
        require(t.playerCount < t.maxPlayers, "Tournament: full");
        require(!joined[id][msg.sender], "Tournament: already joined");

        joined[id][msg.sender] = true;
        entrants[id].push(msg.sender);
        t.playerCount += 1;
        t.prizePool += t.entryFee;

        if (t.entryFee > 0) {
            IERC20(t.token).safeTransferFrom(msg.sender, address(this), t.entryFee);
        }
        emit Joined(id, msg.sender, t.playerCount);
    }

    /// @notice Top up a tournament's prize pool (sponsor / Treasury funded
    ///         free-rolls). Sponsored funds are never refunded to entrants; on a
    ///         cancellation they sweep to the Treasury.
    function fund(uint256 id, uint128 amount) external nonReentrant {
        Tournament storage t = tournaments[id];
        require(t.status == Status.Open, "Tournament: not open");
        require(amount > 0, "Tournament: zero fund");

        t.prizePool += amount;
        t.sponsored += amount;
        IERC20(t.token).safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(id, msg.sender, amount);
    }

    /// @notice Report the final standings and pay out. `winners[i]` takes
    ///         `payoutBps[i]` of the distributable pool (pool minus the protocol
    ///         cut). The operator only chooses the ordering — never the amounts —
    ///         and every winner must be a registered entrant. Any payout share for
    ///         places that the field was too small to fill sweeps to the Treasury.
    function finalize(uint256 id, address[] calldata winners) external onlyOperator nonReentrant {
        Tournament storage t = tournaments[id];
        require(t.status == Status.Open, "Tournament: not open");
        require(t.playerCount >= MIN_PLAYERS, "Tournament: under-filled");
        require(winners.length > 0 && winners.length <= t.payoutBps.length, "Tournament: bad winners");
        require(winners.length <= t.playerCount, "Tournament: more winners than players");

        // effects before interactions
        t.status = Status.Finalized;

        IERC20 token = IERC20(t.token);
        uint256 pool = t.prizePool;
        uint256 cut = (pool * t.cutBps) / BPS;
        uint256 distributable = pool - cut;

        uint256 distributed;
        for (uint256 i = 0; i < winners.length; i++) {
            address w = winners[i];
            require(joined[id][w], "Tournament: winner not entrant");
            // reject duplicate winners (would let the operator overpay one address)
            for (uint256 j = 0; j < i; j++) {
                require(winners[j] != w, "Tournament: duplicate winner");
            }
            uint256 prize = (distributable * t.payoutBps[i]) / BPS;
            if (prize > 0) {
                distributed += prize;
                token.safeTransfer(w, prize);
                emit PrizePaid(id, w, prize);
            }
        }

        // cut + rounding dust + shares for unfilled places all go to the Treasury
        uint256 toTreasury = pool - distributed;
        if (toTreasury > 0) {
            token.safeTransfer(treasury, toTreasury);
            emit FeeCollected(id, t.token, toTreasury);
        }
        emit Finalized(id, winners, distributed, toTreasury);
    }

    /// @notice Refund every entrant their entry fee and close the tournament.
    ///         Permissionless once either the tournament is under-filled past its
    ///         join deadline, or the operator has failed to finalise by the refund
    ///         deadline — so funds can never be trapped by an absent operator.
    function refund(uint256 id) external nonReentrant {
        Tournament storage t = tournaments[id];
        require(t.status == Status.Open, "Tournament: not open");
        bool underFilled = block.timestamp > t.joinDeadline && t.playerCount < MIN_PLAYERS;
        bool stale = block.timestamp > t.refundDeadline;
        require(underFilled || stale, "Tournament: not refundable");

        // effects before interactions
        t.status = Status.Cancelled;

        IERC20 token = IERC20(t.token);
        uint128 fee = t.entryFee;
        address[] storage list = entrants[id];
        if (fee > 0) {
            for (uint256 i = 0; i < list.length; i++) {
                token.safeTransfer(list[i], fee);
            }
        }
        // sponsor money isn't the entrants' to reclaim — it sweeps to the Treasury
        if (t.sponsored > 0) {
            token.safeTransfer(treasury, t.sponsored);
        }
        emit Cancelled(id, t.playerCount);
    }

    // ------------------------------ views ------------------------------- //

    function getTournament(uint256 id) external view returns (Tournament memory) {
        return tournaments[id];
    }

    function getEntrants(uint256 id) external view returns (address[] memory) {
        return entrants[id];
    }

    /// @notice Pool, cut and per-place prizes a tournament currently implies, so the
    ///         UI can show "win up to X" without re-deriving the split.
    function prizeBreakdown(uint256 id)
        external
        view
        returns (uint256 pool, uint256 cut, uint256[] memory prizes)
    {
        Tournament storage t = tournaments[id];
        pool = t.prizePool;
        cut = (pool * t.cutBps) / BPS;
        uint256 distributable = pool - cut;
        prizes = new uint256[](t.payoutBps.length);
        for (uint256 i = 0; i < t.payoutBps.length; i++) {
            prizes[i] = (distributable * t.payoutBps[i]) / BPS;
        }
    }

    // ------------------------------ admin ------------------------------- //

    function setTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "Tournament: treasury zero");
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setOperator(address operator_) external onlyOwner {
        require(operator_ != address(0), "Tournament: operator zero");
        operator = operator_;
        emit OperatorUpdated(operator_);
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }
}
