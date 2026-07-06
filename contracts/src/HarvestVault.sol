// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ILendingPool} from "./interfaces/ILendingPool.sol";

/// @title HarvestVault — no-loss Awalé league
/// @notice Players deposit a stablecoin for a season; the pooled deposit is
///         supplied to a Celo lending market and accrues yield. At season end a
///         keeper finalizes: the vault withdraws everything, and the *yield* is
///         distributed to the leaderboard via a Merkle root while every player's
///         **principal is always returned in full** (the no-loss guarantee).
///
/// @dev Accounting is kept exact by allowing only one un-finalized season per
///      token, so the lending receipt (aToken) balance for that token maps to a
///      single season. Yield := withdrawn − totalPrincipal. Prize claims are
///      capped at the realised yield, so the contract can never pay out more
///      than it earned even if the finalized Merkle root is malformed.
///
///      No-loss holds only while the underlying lending market is solvent; a
///      de-peg or bad-debt event in the market is an external risk (architecture
///      §13). Mitigate by using audited, liquid markets and capping exposure.
contract HarvestVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open, // accepting deposits / running
        Finalized // withdrawn from the market; principal & prizes claimable
    }

    struct Season {
        address token; // staked stablecoin
        address pool; // lending market (Aave V3 / Moola)
        uint64 depositDeadline; // deposits accepted up to here
        uint64 seasonEnd; // finalize allowed after here
        Status status;
        uint256 totalPrincipal; // sum of all deposits
        uint256 redeemed; // total token withdrawn from the market at finalize
        uint256 yieldPot; // redeemed − totalPrincipal (the prize pool)
        uint256 prizeDistributed; // running total of claimed prizes (≤ yieldPot)
        bytes32 prizeMerkleRoot; // root over leaves keccak256(abi.encode(account, amount))
    }

    /// @notice Protocol share of the YIELD (never the principal), in bps.
    ///         0 by default — the no-loss promise is untouched either way:
    ///         every depositor's principal always returns in full, the fee
    ///         only trims the prize pool the winners share.
    uint16 public yieldFeeBps;
    uint16 public constant MAX_YIELD_FEE_BPS = 3000; // protocol can never take >30% of yield
    address public feeTreasury;

    uint256 public nextSeasonId = 1;
    mapping(uint256 => Season) public seasons;
    mapping(uint256 => mapping(address => uint256)) public principalOf;
    mapping(uint256 => mapping(address => bool)) public prizeClaimed;
    /// @dev token => the single un-finalized season for it (0 if none)
    mapping(address => uint256) public activeSeasonForToken;

    event SeasonCreated(
        uint256 indexed seasonId, address indexed token, address pool, uint64 depositDeadline, uint64 seasonEnd
    );
    event Deposited(uint256 indexed seasonId, address indexed player, uint256 amount);
    event Finalized(uint256 indexed seasonId, uint256 redeemed, uint256 yieldPot, bytes32 prizeMerkleRoot);
    event PrincipalClaimed(uint256 indexed seasonId, address indexed player, uint256 amount);
    event PrizeClaimed(uint256 indexed seasonId, address indexed player, uint256 amount);
    event YieldFeeUpdated(address indexed treasury, uint16 bps);
    event YieldFeeCollected(uint256 indexed seasonId, uint256 amount);

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Configure the protocol's share of realised yield. Capped, and
    ///         requires a treasury when non-zero.
    function setYieldFee(address treasury_, uint16 bps) external onlyOwner {
        require(bps <= MAX_YIELD_FEE_BPS, "HarvestVault: fee too high");
        require(bps == 0 || treasury_ != address(0), "HarvestVault: treasury zero");
        feeTreasury = treasury_;
        yieldFeeBps = bps;
        emit YieldFeeUpdated(treasury_, bps);
    }

    // ----------------------------- seasons ------------------------------ //

    /// @notice Open a new season for `token` on lending market `pool`.
    function createSeason(address token, address pool, uint64 depositDeadline, uint64 seasonEnd)
        external
        onlyOwner
        nonReentrant
        returns (uint256 seasonId)
    {
        require(token != address(0) && pool != address(0), "HarvestVault: zero addr");
        require(depositDeadline < seasonEnd, "HarvestVault: bad schedule");
        require(seasonEnd > block.timestamp, "HarvestVault: end in past");
        require(activeSeasonForToken[token] == 0, "HarvestVault: token busy");

        seasonId = nextSeasonId++;
        Season storage s = seasons[seasonId];
        s.token = token;
        s.pool = pool;
        s.depositDeadline = depositDeadline;
        s.seasonEnd = seasonEnd;
        s.status = Status.Open;

        activeSeasonForToken[token] = seasonId;
        emit SeasonCreated(seasonId, token, pool, depositDeadline, seasonEnd);
    }

    // ----------------------------- deposit ------------------------------ //

    /// @notice Deposit `amount` into a season; supplied straight to the market.
    function deposit(uint256 seasonId, uint256 amount) external nonReentrant {
        Season storage s = seasons[seasonId];
        require(s.status == Status.Open, "HarvestVault: not open");
        require(block.timestamp <= s.depositDeadline, "HarvestVault: deposits closed");
        require(amount > 0, "HarvestVault: zero amount");

        principalOf[seasonId][msg.sender] += amount;
        s.totalPrincipal += amount;

        IERC20 token = IERC20(s.token);
        token.safeTransferFrom(msg.sender, address(this), amount);
        token.forceApprove(s.pool, amount);
        ILendingPool(s.pool).supply(s.token, amount, address(this), 0);

        emit Deposited(seasonId, msg.sender, amount);
    }

    // ---------------------------- finalize ------------------------------ //

    /// @notice After the season ends, withdraw everything from the market and
    ///         commit the prize Merkle root over the final standings.
    function finalize(uint256 seasonId, bytes32 prizeMerkleRoot) external onlyOwner nonReentrant {
        Season storage s = seasons[seasonId];
        require(s.status == Status.Open, "HarvestVault: not open");
        require(block.timestamp > s.seasonEnd, "HarvestVault: season not ended");

        s.status = Status.Finalized;
        activeSeasonForToken[s.token] = 0;

        // withdraw the vault's entire position for this token (single active season)
        uint256 redeemed = ILendingPool(s.pool).withdraw(s.token, type(uint256).max, address(this));
        s.redeemed = redeemed;
        uint256 yieldPot = redeemed > s.totalPrincipal ? redeemed - s.totalPrincipal : 0;
        // protocol fee comes out of the YIELD only — the principal below this
        // line is untouched, so the no-loss guarantee cannot be affected
        uint256 fee = (yieldPot * yieldFeeBps) / 10_000;
        if (fee > 0) {
            yieldPot -= fee;
            IERC20(s.token).safeTransfer(feeTreasury, fee);
            emit YieldFeeCollected(seasonId, fee);
        }
        s.yieldPot = yieldPot;
        s.prizeMerkleRoot = prizeMerkleRoot;

        emit Finalized(seasonId, redeemed, s.yieldPot, prizeMerkleRoot);
    }

    // ------------------------------ claims ------------------------------ //

    /// @notice Reclaim your principal after finalization.
    /// @dev No-loss in the normal case: `redeemed >= totalPrincipal`, so every
    ///      depositor gets their full principal back and the excess is the
    ///      yieldPot (paid separately as prizes). If the lending market suffered
    ///      a SHORTFALL (`redeemed < totalPrincipal` — a de-peg / bad-debt event,
    ///      finding M-02), the recovered amount is shared **pro-rata**: each
    ///      player receives `principal * redeemed / totalPrincipal`. This shares
    ///      the loss fairly across all depositors instead of the previous
    ///      first-come-first-served race, where early claimants withdrew in full
    ///      and late claimants found the vault empty and reverted.
    function claimPrincipal(uint256 seasonId) external nonReentrant {
        Season storage s = seasons[seasonId];
        require(s.status == Status.Finalized, "HarvestVault: not finalized");

        uint256 amount = principalOf[seasonId][msg.sender];
        require(amount > 0, "HarvestVault: nothing to claim");
        principalOf[seasonId][msg.sender] = 0;

        // pro-rata on shortfall; full principal otherwise. Rounding is down per
        // player, so the sum of payouts never exceeds `redeemed` (leftover dust
        // stays in the vault — it can never over-pay).
        uint256 payout = amount;
        if (s.redeemed < s.totalPrincipal) {
            payout = (amount * s.redeemed) / s.totalPrincipal;
        }

        IERC20(s.token).safeTransfer(msg.sender, payout);
        emit PrincipalClaimed(seasonId, msg.sender, payout);
    }

    /// @notice Claim a yield prize with a Merkle proof over the final standings.
    function claimPrize(uint256 seasonId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Season storage s = seasons[seasonId];
        require(s.status == Status.Finalized, "HarvestVault: not finalized");
        require(!prizeClaimed[seasonId][msg.sender], "HarvestVault: prize claimed");

        bytes32 leaf = keccak256(abi.encode(msg.sender, amount));
        require(MerkleProof.verify(proof, s.prizeMerkleRoot, leaf), "HarvestVault: bad proof");

        // solvency guard: never distribute more than the realised yield
        require(s.prizeDistributed + amount <= s.yieldPot, "HarvestVault: exceeds yield");

        prizeClaimed[seasonId][msg.sender] = true;
        s.prizeDistributed += amount;

        IERC20(s.token).safeTransfer(msg.sender, amount);
        emit PrizeClaimed(seasonId, msg.sender, amount);
    }

    // ------------------------------ views ------------------------------- //

    /// @notice What `claimPrincipal` would pay `account` right now: the full
    ///         principal normally, or the pro-rata share after a market shortfall
    ///         (M-02). 0 once claimed or if never deposited. Lets the UI show the
    ///         true recoverable amount instead of the nominal deposit.
    function claimablePrincipal(uint256 seasonId, address account) external view returns (uint256) {
        Season storage s = seasons[seasonId];
        uint256 amount = principalOf[seasonId][account];
        if (amount == 0 || s.status != Status.Finalized) return amount;
        if (s.redeemed < s.totalPrincipal) return (amount * s.redeemed) / s.totalPrincipal;
        return amount;
    }

    function getSeason(uint256 seasonId) external view returns (Season memory) {
        return seasons[seasonId];
    }
}
