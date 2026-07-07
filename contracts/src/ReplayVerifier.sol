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
///      (matchId, ply, house, stateHash(pre-move state)) by the session key of
///      the player to move — the state binding makes each signature unique to
///      its exact board position.
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
        keccak256("Move(uint256 matchId,uint256 ply,uint8 house,bytes32 state)");

    bytes32 private constant TURNACK_TYPEHASH = keccak256("TurnAck(uint256 matchId,uint256 ply,bytes32 state)");

    /// @dev Upper bound on transcript length, guarding the replay loop against
    ///      an unbounded-gas griefing submission. Repetition ends real games in
    ///      far fewer plies.
    /// @dev INVARIANT (forfeit liveness): a real Awalé game terminates well below
    ///      MAX_PLIES — the 40-ply no-capture split (AwaleRules.NO_CAPTURE_LIMIT)
    ///      plus ≤24 captures caps it near ~1000 plies. MatchEscrow.rebutForfeit
    ///      relies on this: an accused must always be able to answer a forfeit at
    ///      ply P with a transcript of length P+1 ≤ MAX_PLIES. Do NOT raise
    ///      NO_CAPTURE_LIMIT / capture bounds toward MAX_PLIES, nor lower MAX_PLIES
    ///      toward achievable game lengths, or a forfeit could become un-rebuttable.
    uint256 internal constant MAX_PLIES = 4096;

    /// @dev Positions (board + turn) recurring this many times SINCE THE LAST
    ///      CAPTURE end the game as a provable cycle — the anti-stall rule,
    ///      mirroring engine `adjudicate` (REPETITION_LIMIT). Threefold.
    uint8 internal constant REPETITION_LIMIT = 3;

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
            abi.encode(DOMAIN_TYPEHASH, keccak256("AwaleReplayVerifier"), keccak256("1"), block.chainid, address(this))
        );
    }

    /// @notice EIP-712 digest a session key must sign to authorise one move.
    /// @param state hash of the PRE-move game state ({stateHash}). Binding the
    ///        signature to the exact position makes each ply signature unique to
    ///        its board: a signature cannot be replayed at a different position
    ///        nor spliced into a fabricated line (closes ply-equivocation and
    ///        keeps the forfeit-clock history unforkable).
    function moveDigest(uint256 matchId, uint256 ply, uint8 house, bytes32 state) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(MOVE_TYPEHASH, matchId, ply, house, state));
        return MessageHashUtils.toTypedDataHash(DOMAIN_SEPARATOR, structHash);
    }

    /// @notice Canonical hash of the pre-move game state a move signature binds to.
    /// @dev Must be reproduced byte-for-byte off-chain by the game engine when it
    ///      signs a move. Covers every field that distinguishes one game moment
    ///      from another: the full board, both stores, whose turn it is, and the
    ///      no-capture clock (which governs future termination).
    function stateHash(AwaleRules.GameState memory s) public pure returns (bytes32) {
        return keccak256(abi.encode(s.pits, s.store0, s.store1, s.turn, s.noCaptureCount));
    }

    /// @notice EIP-712 digest a player's session key signs to ACKNOWLEDGE that at
    ///         position `state` it is ply `ply` and their turn to move.
    /// @dev A forfeit may only be opened against a position the accused
    ///      acknowledged (see MatchEscrow.proposeForfeit), so a claimant cannot
    ///      fabricate "opponent to move" by signing a never-played move of their
    ///      own — the accused never acks a state their client never received.
    ///      The client signs this automatically upon receiving the opponent's
    ///      turn-flipping move; `state` is stateHash(the pre-move position).
    function ackDigest(uint256 matchId, uint256 ply, bytes32 state) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(TURNACK_TYPEHASH, matchId, ply, state));
        return MessageHashUtils.toTypedDataHash(DOMAIN_SEPARATOR, structHash);
    }

    /// @notice Replay a transcript and return the resulting game state.
    /// @dev Reverts if signature counts mismatch, a signature is wrong, or any
    ///      move is illegal. The caller (MatchEscrow) reads `over` and `winner`.
    /// @return state the final game state after replaying every move
    function verify(Transcript calldata t) public view returns (AwaleRules.GameState memory state) {
        require(t.startTurn < 2, "ReplayVerifier: bad startTurn");
        require(t.moves.length == t.sigs.length, "ReplayVerifier: length mismatch");
        require(t.moves.length > 0, "ReplayVerifier: empty transcript");
        require(t.moves.length <= MAX_PLIES, "ReplayVerifier: too many plies");
        require(t.session0 != address(0) && t.session1 != address(0), "ReplayVerifier: zero session key");
        require(t.session0 != t.session1, "ReplayVerifier: duplicate session key");

        state = AwaleRules.initialState();
        state.turn = t.startTurn;

        // Position keys seen SINCE THE LAST CAPTURE, to detect a threefold
        // repetition (the anti-stall rule) exactly as engine `adjudicate` does.
        // A capture removes seeds for good, so no pre-capture position can ever
        // recur — the window resets on every capture, keeping this bounded.
        bytes32[] memory seen = new bytes32[](t.moves.length + 1);
        uint256 seenLen = 0;
        seen[seenLen++] = _positionKey(state);

        for (uint256 ply = 0; ply < t.moves.length; ply++) {
            address expected = state.turn == 0 ? t.session0 : t.session1;
            // bind the signature to the exact pre-move position (anti-splice/equivocation)
            bytes32 digest = moveDigest(t.matchId, ply, t.moves[ply], stateHash(state));
            address signer = ECDSA.recover(digest, t.sigs[ply]);
            require(signer == expected, "ReplayVerifier: bad move signature");

            uint256 potBefore = uint256(state.store0) + uint256(state.store1);

            // applyMove reverts on any illegal move, including a move after the
            // game has already ended — so a transcript with moves past a base-
            // rule end (majority / starvation / 40-ply split) can never verify.
            state = AwaleRules.applyMove(state, t.moves[ply]);
            if (state.over) continue; // a base rule ended it; next ply (if any) reverts

            if (uint256(state.store0) + uint256(state.store1) > potBefore) {
                seenLen = 0; // a capture is real progress — no repetition crosses it
                seen[seenLen++] = _positionKey(state);
                continue;
            }

            bytes32 key = _positionKey(state);
            uint256 count = 1;
            for (uint256 j = 0; j < seenLen; j++) {
                if (seen[j] == key) count++;
            }
            seen[seenLen++] = key;
            if (count >= REPETITION_LIMIT) {
                // Provable cycle: each side banks its own row, seed leader wins
                // (equal ⇒ draw). Setting `over` here means any further ply in the
                // transcript hits applyMove's "game over" revert on the next loop
                // — so a repetition-ended transcript must also be exactly minimal.
                _endByCycle(state);
            }
        }
    }

    /// @dev Canonical key of a position: the board plus whose turn it is. Same
    ///      equality semantics as engine `positionKey` — two moments hash equal
    ///      iff they are the same position. (The hash VALUE need not match the
    ///      engine's string form; only equality within one replay is load-bearing.)
    function _positionKey(AwaleRules.GameState memory s) private pure returns (bytes32) {
        return keccak256(abi.encode(s.pits, s.turn));
    }

    /// @dev End a provably-cyclic game the official Awalé way, mirroring engine
    ///      `endByCycle`: each side collects the seeds in its own row, then the
    ///      seed leader wins (equal ⇒ draw). Same award as the 40-ply split —
    ///      only the trigger is earlier. Sums fit uint8 (48 seeds total).
    function _endByCycle(AwaleRules.GameState memory s) private pure {
        uint8 row0 = 0;
        uint8 row1 = 0;
        for (uint256 i = 0; i < 6; i++) {
            row0 += s.pits[i];
            row1 += s.pits[i + 6];
        }
        s.store0 += row0;
        s.store1 += row1;
        for (uint256 i = 0; i < 12; i++) {
            s.pits[i] = 0;
        }
        s.over = true;
        s.winner = s.store0 > s.store1 ? 0 : (s.store1 > s.store0 ? 1 : AwaleRules.DRAW);
    }

    /// @notice Canonical hash binding a match to its move sequence and first mover.
    /// @dev Stored by MatchEscrow at optimistic settlement; a challenger submits
    ///      the full transcript and the contract checks it hashes to this value.
    function transcriptHash(uint256 matchId, uint8 startTurn, uint8[] calldata moves) public pure returns (bytes32) {
        return keccak256(abi.encode(matchId, startTurn, moves));
    }
}
