// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// Minimal Chainlink VRF v2.5 surface, inlined so this scaffold compiles without
// pulling the full chainlink/contracts dependency. At mainnet, replace with the
// real imports: VRFConsumerBaseV2Plus + VRFV2PlusClient from chainlink/contracts.
interface IVRFCoordinatorV2Plus {
    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    function requestRandomWords(RandomWordsRequest calldata req) external returns (uint256 requestId);
}

/// @title VRFFirstMover — verifiable first-mover coin flip (UNUSED ON CELO)
/// @notice ⚠️ NOT USED, AND NOT USABLE ON CELO MAINNET. Chainlink VRF is not
///         deployed on Celo: Celo's own Chainlink page documents CCIP only, and
///         Celo does not appear in Chainlink's VRF v2.5 supported-network list.
///         Supra's dVRF lists Celo TESTNET only, with no mainnet deployment.
///         There is, as of this writing, no production VRF on Celo mainnet — so
///         the "fund a subscription at mainnet" plan this scaffold was written
///         for cannot be carried out.
///
///         MatchEscrow therefore does NOT use this contract. It settles the
///         first move with a two-party commit–reveal instead, which needs no
///         oracle at all: each player commits keccak256(secret) in the
///         transaction that stakes them and the flip is keccak(secret0,
///         secret1, matchId). See MatchEscrow's commit–reveal notes.
///
/// @dev Kept only as a reference implementation in case a VRF service ships on
///      Celo mainnet later. Do not deploy it expecting randomness today.
contract VRFFirstMover is Ownable {
    IVRFCoordinatorV2Plus public immutable coordinator;
    bytes32 public keyHash; // gas lane
    uint256 public subId; // funded VRF subscription
    uint16 public requestConfirmations = 3;
    uint32 public callbackGasLimit = 120_000;

    /// @notice Who may request a flip (the escrow / keeper). Gate so randomness
    ///         requests — which cost LINK/native from the subscription — can't
    ///         be spammed by anyone.
    mapping(address => bool) public requester;

    struct Flip {
        bool requested;
        bool fixed_; // fulfilled
        uint8 start; // 0 or 1, valid once fixed_
    }

    mapping(uint256 => Flip) public flips; // matchId => flip
    mapping(uint256 => uint256) public matchOf; // VRF requestId => matchId

    event FirstMoverRequested(uint256 indexed matchId, uint256 indexed requestId);
    event FirstMoverFixed(uint256 indexed matchId, uint8 start);
    event RequesterSet(address indexed who, bool allowed);
    event ConfigUpdated(bytes32 keyHash, uint256 subId, uint16 confirmations, uint32 callbackGasLimit);

    error NotCoordinator();
    error NotRequester();
    error AlreadyRequested();
    error NotFixed();

    constructor(address coordinator_, bytes32 keyHash_, uint256 subId_, address owner_) Ownable(owner_) {
        require(coordinator_ != address(0), "VRF: coordinator zero");
        coordinator = IVRFCoordinatorV2Plus(coordinator_);
        keyHash = keyHash_;
        subId = subId_;
    }

    // ------------------------------ admin ------------------------------- //

    function setRequester(address who, bool allowed) external onlyOwner {
        requester[who] = allowed;
        emit RequesterSet(who, allowed);
    }

    function setConfig(bytes32 keyHash_, uint256 subId_, uint16 confirmations_, uint32 callbackGasLimit_)
        external
        onlyOwner
    {
        keyHash = keyHash_;
        subId = subId_;
        requestConfirmations = confirmations_;
        callbackGasLimit = callbackGasLimit_;
        emit ConfigUpdated(keyHash_, subId_, confirmations_, callbackGasLimit_);
    }

    // ----------------------------- request ------------------------------ //

    /// @notice Request the VRF flip for `matchId`. Idempotent-guarded: one
    ///         request per match. Only an authorized requester (escrow/keeper).
    function requestFirstMover(uint256 matchId) external returns (uint256 requestId) {
        if (!requester[msg.sender]) revert NotRequester();
        if (flips[matchId].requested) revert AlreadyRequested();
        flips[matchId].requested = true;

        requestId = coordinator.requestRandomWords(
            IVRFCoordinatorV2Plus.RandomWordsRequest({
                keyHash: keyHash,
                subId: subId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                // extraArgs = VRFV2PlusClient._argsToBytes(ExtraArgsV1{nativePayment:false}):
                // the v2.5 tag bytes4(keccak256("VRF ExtraArgsV1")) = 0x92fd1338,
                // then abi.encode(false) → pay in LINK. Built inline so the
                // scaffold needs no Chainlink dependency; swap for the real
                // VRFV2PlusClient helper at mainnet. Set true to pay in native.
                extraArgs: abi.encodeWithSelector(bytes4(0x92fd1338), false)
            })
        );
        matchOf[requestId] = matchId;
        emit FirstMoverRequested(matchId, requestId);
    }

    /// @dev VRF callback. The real VRFConsumerBaseV2Plus routes the coordinator
    ///      call into `fulfillRandomWords`; here we gate it explicitly to the
    ///      coordinator so the scaffold is self-contained.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != address(coordinator)) revert NotCoordinator();
        uint256 matchId = matchOf[requestId];
        Flip storage f = flips[matchId];
        if (f.fixed_) return; // idempotent: ignore a duplicate fulfilment
        f.fixed_ = true;
        f.start = uint8(randomWords[0] & 1);
        emit FirstMoverFixed(matchId, f.start);
    }

    // ------------------------------ views ------------------------------- //

    /// @notice The fixed first mover (0 or 1) for `matchId`. Reverts until VRF
    ///         has fulfilled — callers gate their start on {isFixed}.
    function firstMover(uint256 matchId) external view returns (uint8) {
        if (!flips[matchId].fixed_) revert NotFixed();
        return flips[matchId].start;
    }

    function isFixed(uint256 matchId) external view returns (bool) {
        return flips[matchId].fixed_;
    }
}
