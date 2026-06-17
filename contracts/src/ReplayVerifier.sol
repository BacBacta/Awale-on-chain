// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {AwaleRules} from "./AwaleRules.sol";

/// @title ReplayVerifier — on-chain dispute resolution for Awalé matches
/// @notice Re-executes a disputed match from its signed transcript and returns
///         the canonical outcome. The happy path never calls this contract; it
///         exists so a cheated player can always prove the true result on-chain.
///
/// @dev Fairness model (architecture §7): MiniPay forbids wallet message
///      signing, so each player signs their *moves* with a per-match **session
///      key** — an ephemeral EVM address registered on-chain when they join the
///      match. A move signature is an EIP-712 typed-data signature over
///      (matchId, ply, house) by the session key of the player to move.
///
///      Verification is deterministic and self-contained:
///        1. start from the opening position with the agreed first mover;
///        2. for each ply, recover the signer and require it to equal the
///           session key of whoever is to move at that ply;
///        3. apply the move through {AwaleRules}, which reverts on any illegal
///           move — so an invalid transcript can never produce an outcome.
///
///      Because both the off-chain server and this contract run the identical
///      {AwaleRules} engine, a valid transcript replays to byte-identical state.
contract ReplayVerifier {
    using AwaleRules for AwaleRules.GameState;

    /// @dev EIP-712 typed-data domain, bound to chain id and this deployment so
    ///      a signature can never be replayed against another contract or chain.
    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant MOVE_TYPEHASH =
        keccak256("Move(uint256 matchId,uint256 ply,uint8 house)");

    /// @param matchId      identifier shared with MatchEscrow
    /// @param session0     session key (ephemeral address) of player 0 (South)
    /// @param session1     session key (ephemeral address) of player 1 (North)
    /// @param startTurn    which player makes the first move (0 or 1)
    /// @param moves        house played at each ply (0..5, relative to the mover)
    /// @param sigs         per-ply EIP-712 signature by the mover's session key
    struct Transcript {
        uint256 matchId;
        address session0;
        address session1;
        uint8 startTurn;
        uint8[] moves;
        bytes[] sigs;
    }

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("AwaleReplayVerifier"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice EIP-712 digest a session key must sign to authorise one move.
    function moveDigest(uint256 matchId, uint256 ply, uint8 house) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(MOVE_TYPEHASH, matchId, ply, house));
        return MessageHashUtils.toTypedDataHash(DOMAIN_SEPARATOR, structHash);
    }

    /// @notice Replay a transcript and return the resulting game state.
    /// @dev Reverts if signature counts mismatch, a signature is wrong, or any
    ///      move is illegal. The caller (MatchEscrow) reads `over` and `winner`.
    /// @return state the final game state after replaying every move
    function verify(Transcript calldata t) public view returns (AwaleRules.GameState memory state) {
        require(t.startTurn < 2, "ReplayVerifier: bad startTurn");
        require(t.moves.length == t.sigs.length, "ReplayVerifier: length mismatch");
        require(t.session0 != address(0) && t.session1 != address(0), "ReplayVerifier: zero session key");
        require(t.session0 != t.session1, "ReplayVerifier: duplicate session key");

        state = AwaleRules.initialState();
        state.turn = t.startTurn;

        for (uint256 ply = 0; ply < t.moves.length; ply++) {
            address expected = state.turn == 0 ? t.session0 : t.session1;
            bytes32 digest = moveDigest(t.matchId, ply, t.moves[ply]);
            address signer = ECDSA.recover(digest, t.sigs[ply]);
            require(signer == expected, "ReplayVerifier: bad move signature");

            // applyMove reverts on any illegal move, including a move after the
            // game has already ended — so the transcript must be exactly minimal.
            state = AwaleRules.applyMove(state, t.moves[ply]);
        }
    }

    /// @notice Canonical hash binding a match to its move sequence and first mover.
    /// @dev Stored by MatchEscrow at optimistic settlement; a challenger submits
    ///      the full transcript and the contract checks it hashes to this value.
    function transcriptHash(uint256 matchId, uint8 startTurn, uint8[] calldata moves)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(matchId, startTurn, moves));
    }
}
