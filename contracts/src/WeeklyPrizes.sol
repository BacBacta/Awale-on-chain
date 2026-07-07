// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title WeeklyPrizes — trust-minimised payout of the Weekly race pot
/// @notice Replaces the custodial "the server sends you your prize" model with
///         a Merkle distributor: each week the operator funds the pot INTO this
///         contract and publishes a Merkle root over the winners. A winner then
///         claims from the CONTRACT with a proof — the contract, not the
///         server, verifies the claim and pays. So the winners list is sealed
///         on-chain and the money sits in the contract: even if the operator
///         disappears or turns hostile, a winner can still collect what the
///         published root owes them.
///
/// @dev Leaf convention matches HarvestVault (and the server's buildPrizeTree):
///          leaf = keccak256(abi.encode(account, amount))
///      with OpenZeppelin sorted-pair internal hashing. `account` is bound into
///      the leaf and checked against msg.sender, so only the winner can claim
///      their own prize. Per-round solvency (`claimed + amount <= funded`) means
///      a malformed root can never drain another week's funds.
contract WeeklyPrizes is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Round {
        address token; // stablecoin the pot is paid in
        bytes32 merkleRoot; // root over the winners for this week
        uint128 funded; // tokens actually received for this round (measured)
        uint128 claimed; // running total paid out (≤ funded)
        uint64 reclaimAfter; // owner may sweep the unclaimed remainder after this
    }

    /// @dev round id is the week (the server passes its week number). Unique &
    ///      immutable once published.
    mapping(uint256 => Round) public rounds;
    /// @dev round => winner => already claimed. One claim per winner per week.
    mapping(uint256 => mapping(address => bool)) public claimed;

    event RoundPublished(uint256 indexed round, address indexed token, bytes32 root, uint256 funded, uint64 reclaimAfter);
    event Claimed(uint256 indexed round, address indexed account, uint256 amount);
    event Swept(uint256 indexed round, address indexed to, uint256 amount);

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Fund and seal one week's payout. Pulls `amount` of `token` from
    ///         the caller and commits `root`. The amount actually received is
    ///         measured (fee-on-transfer safe) and becomes the round's funding
    ///         ceiling — claims can never exceed it.
    /// @param round        the week id (server's week number); must be fresh
    /// @param reclaimAfter unix time after which {sweep} may recover leftovers
    function publishRound(uint256 round, address token, bytes32 root, uint256 amount, uint64 reclaimAfter)
        external
        onlyOwner
        nonReentrant
    {
        require(rounds[round].merkleRoot == bytes32(0), "WeeklyPrizes: round exists");
        require(root != bytes32(0), "WeeklyPrizes: empty root");
        require(token != address(0), "WeeklyPrizes: token zero");
        require(amount > 0, "WeeklyPrizes: amount zero");

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        require(received > 0 && received <= type(uint128).max, "WeeklyPrizes: bad funding");

        rounds[round] = Round({
            token: token,
            merkleRoot: root,
            funded: uint128(received),
            claimed: 0,
            reclaimAfter: reclaimAfter
        });
        emit RoundPublished(round, token, root, received, reclaimAfter);
    }

    /// @notice Claim your prize for `round`. The proof is verified against the
    ///         week's published root; only the winner (leaf account) can call.
    function claim(uint256 round, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Round storage r = rounds[round];
        require(r.merkleRoot != bytes32(0), "WeeklyPrizes: no round");
        require(!claimed[round][msg.sender], "WeeklyPrizes: already claimed");

        bytes32 leaf = keccak256(abi.encode(msg.sender, amount));
        require(MerkleProof.verify(proof, r.merkleRoot, leaf), "WeeklyPrizes: bad proof");
        // per-round solvency: a malformed/over-allocated root can never pay out
        // more than this week was funded, so it can't reach into another week
        require(uint256(r.claimed) + amount <= r.funded, "WeeklyPrizes: exceeds funding");

        claimed[round][msg.sender] = true;
        r.claimed = uint128(uint256(r.claimed) + amount);
        IERC20(r.token).safeTransfer(msg.sender, amount);
        emit Claimed(round, msg.sender, amount);
    }

    /// @notice After a round's reclaim window, recover the unclaimed remainder
    ///         (e.g. to roll it into next week's pot, or to the treasury). Sets
    ///         claimed = funded, which both prevents a double-sweep and closes
    ///         the round to further claims.
    function sweep(uint256 round, address to) external onlyOwner nonReentrant {
        Round storage r = rounds[round];
        require(r.merkleRoot != bytes32(0), "WeeklyPrizes: no round");
        require(block.timestamp > r.reclaimAfter, "WeeklyPrizes: window open");
        require(to != address(0), "WeeklyPrizes: to zero");

        uint256 leftover = uint256(r.funded) - r.claimed;
        require(leftover > 0, "WeeklyPrizes: nothing to sweep");
        r.claimed = r.funded;
        IERC20(r.token).safeTransfer(to, leftover);
        emit Swept(round, to, leftover);
    }

    /// @notice What `account` can still claim for `round` (0 once claimed, or if
    ///         they aren't a winner). The UI shows this so a figure is never
    ///         promised that the contract wouldn't pay. Verifying needs the
    ///         proof, so this is a convenience for the "already claimed?" check;
    ///         the amount itself comes from the published claims file.
    function isClaimable(uint256 round, address account) external view returns (bool) {
        return rounds[round].merkleRoot != bytes32(0) && !claimed[round][account];
    }
}
