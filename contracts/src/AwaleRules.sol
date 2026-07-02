// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AwaleRules — deterministic Awalé (Oware Abapa) rule engine
/// @notice Pure, self-contained reference implementation of the Awalé rules,
///         shared by the off-chain game server and the on-chain ReplayVerifier.
///         Determinism is the whole point: given the same start state and the
///         same ordered moves, every replay — in TypeScript or in the EVM —
///         must reach byte-identical state. The library therefore contains no
///         randomness, no storage, and no signature logic (signatures bind a
///         move to a session key one layer up, in ReplayVerifier).
///
/// @dev Canonical variant: **Oware Abapa** (official competition rules).
///      Board layout (sowing runs counter-clockwise, index increasing):
///
///          North (player 1)   11  10   9   8   7   6
///                              --  --  --  --  --  --
///          South (player 0)     0   1   2   3   4   5
///
///      pits[0..5]  belong to player 0 (South); pits[6..11] to player 1 (North).
///      Sowing order is 0 → 1 → ... → 11 → 0 → ... (mod 12).
///
///      Rules implemented:
///        - 12 houses, 4 seeds each at start (48 total); two stores.
///        - A move lifts all seeds from one of the mover's non-empty houses and
///          sows them one per pit, counter-clockwise, skipping the origin house
///          on a full lap (>= 12 seeds).
///        - Capture: if the last sown seed lands in an *opponent* house bringing
///          it to exactly 2 or 3, those seeds are captured, and capture continues
///          backwards over contiguous opponent houses also holding 2 or 3.
///        - Grand slam: a move that would capture *all* of the opponent's seeds
///          is legal but captures nothing (seeds stay on the board).
///        - Feeding obligation: if the opponent has no seeds, the mover must play
///          a move that delivers seeds to the opponent. If none can, the mover
///          collects all remaining seeds and the game ends.
///        - Win at 25 captured seeds (> 24). 24–24 is a draw.
///        - Endless cyclic positions: after NO_CAPTURE_LIMIT consecutive plies
///          with no capture, the board is split (each side's row goes to its
///          own store) and the game ends — guards against a position that can
///          never terminate under the rules above.
library AwaleRules {
    uint8 internal constant PITS = 12;
    uint8 internal constant HOUSES_PER_SIDE = 6;
    uint8 internal constant SEEDS = 48;

    /// @dev winner sentinel for a draw (0 and 1 are the two players)
    uint8 internal constant DRAW = 2;

    /// @dev consecutive non-capturing plies after which the game is split as a draw
    uint8 internal constant NO_CAPTURE_LIMIT = 40;

    struct GameState {
        uint8[12] pits; // 0..5 = player 0 (South), 6..11 = player 1 (North)
        uint8 store0; // seeds captured by player 0
        uint8 store1; // seeds captured by player 1
        uint8 turn; // 0 or 1 — player to move
        bool over; // true once the game has terminated
        uint8 winner; // valid only when `over`: 0, 1, or DRAW
        uint8 noCaptureCount; // plies since the last capture; resets to 0 on any capture
    }

    /// @notice The standard opening position: 4 seeds in every house, player 0 to move.
    function initialState() internal pure returns (GameState memory s) {
        for (uint8 i = 0; i < PITS; i++) {
            s.pits[i] = 4;
        }
        // store0 = store1 = turn = 0, over = false, winner = 0, noCaptureCount = 0 by default
    }

    /// @notice Replay an entire game from the opening position.
    /// @param moves ordered list of houses (0..5, relative to the mover each turn)
    /// @return s the resulting (possibly terminal) state
    function play(uint8[] memory moves) internal pure returns (GameState memory s) {
        s = initialState();
        for (uint256 i = 0; i < moves.length; i++) {
            s = applyMove(s, moves[i]);
        }
    }

    /// @notice Bitmask (bits 0..5) of the houses the current player may legally play.
    function legalMovesMask(GameState memory s) internal pure returns (uint8 mask) {
        if (s.over) return 0;
        bool oppEmpty = _rowSum(s.pits, 1 - s.turn) == 0;
        uint8 base = s.turn == 0 ? 0 : HOUSES_PER_SIDE;
        for (uint8 h = 0; h < HOUSES_PER_SIDE; h++) {
            uint8 idx = base + h;
            if (s.pits[idx] == 0) continue;
            if (oppEmpty) {
                // only moves that feed the opponent are legal
                (uint8[12] memory np,) = _sow(s.pits, idx);
                if (_rowSum(np, 1 - s.turn) == 0) continue;
            }
            mask |= uint8(1) << h;
        }
    }

    /// @notice Whether playing `house` (0..5) is legal in state `s`.
    function isLegal(GameState memory s, uint8 house) internal pure returns (bool) {
        if (house >= HOUSES_PER_SIDE) return false;
        return (legalMovesMask(s) & (uint8(1) << house)) != 0;
    }

    /// @notice Apply one move and return the resulting state. Reverts on any
    ///         illegal move so the verifier can reject a malformed transcript.
    /// @param house house index 0..5 relative to the current player
    function applyMove(GameState memory s, uint8 house) internal pure returns (GameState memory r) {
        require(!s.over, "AwaleRules: game over");
        require(house < HOUSES_PER_SIDE, "AwaleRules: bad house");

        uint8 idx = s.turn == 0 ? house : HOUSES_PER_SIDE + house;
        require(s.pits[idx] > 0, "AwaleRules: empty house");

        bool oppEmpty = _rowSum(s.pits, 1 - s.turn) == 0;

        (uint8[12] memory sown, uint8 lastPos) = _sow(s.pits, idx);

        if (oppEmpty) {
            // feeding obligation: a move is only legal if it reaches the opponent
            require(_rowSum(sown, 1 - s.turn) > 0, "AwaleRules: must feed opponent");
        }

        (uint8[12] memory board, uint8 captured) = _capture(sown, s.turn, lastPos);

        r.pits = board;
        r.store0 = s.store0;
        r.store1 = s.store1;
        if (s.turn == 0) {
            r.store0 += captured;
        } else {
            r.store1 += captured;
        }
        r.turn = 1 - s.turn;
        r.noCaptureCount = captured > 0 ? 0 : s.noCaptureCount + 1;

        _resolve(r);
    }

    // --------------------------------------------------------------------- //
    //                              internals                                //
    // --------------------------------------------------------------------- //

    /// @dev Sow all seeds from house `idx` counter-clockwise, skipping the origin.
    /// @return out the board after sowing, and the index of the last sown seed
    function _sow(uint8[12] memory pits, uint8 idx) private pure returns (uint8[12] memory out, uint8 lastPos) {
        for (uint8 i = 0; i < PITS; i++) {
            out[i] = pits[i];
        }
        uint8 seeds = out[idx];
        out[idx] = 0;
        uint8 pos = idx;
        while (seeds > 0) {
            pos = (pos + 1) % PITS;
            if (pos == idx) continue; // never drop back into the origin house
            out[pos] += 1;
            seeds -= 1;
        }
        return (out, pos);
    }

    /// @dev Resolve captures for `turn` after a sow whose last seed landed at `lastPos`.
    ///      Honours the grand-slam rule (capturing all opponent seeds captures none).
    function _capture(uint8[12] memory pits, uint8 turn, uint8 lastPos)
        private
        pure
        returns (uint8[12] memory out, uint8 captured)
    {
        out = pits;

        // opponent row bounds
        (uint8 lo, uint8 hi) = turn == 0 ? (uint8(6), uint8(11)) : (uint8(0), uint8(5));

        // captures only happen when the last seed lands in the opponent's row
        if (lastPos < lo || lastPos > hi) return (out, 0);

        // walk backwards over contiguous opponent houses holding exactly 2 or 3
        int256 p = int256(uint256(lastPos));
        uint8 take = 0;
        while (p >= int256(uint256(lo)) && (out[uint256(p)] == 2 || out[uint256(p)] == 3)) {
            take += out[uint256(p)];
            p -= 1;
        }
        if (take == 0) return (out, 0);

        // grand-slam guard: never capture the opponent's entire row
        uint8 oppTotal = 0;
        for (uint8 k = lo; k <= hi; k++) {
            oppTotal += out[k];
        }
        if (take == oppTotal) return (out, 0);

        // perform the capture
        p = int256(uint256(lastPos));
        while (p >= int256(uint256(lo)) && (out[uint256(p)] == 2 || out[uint256(p)] == 3)) {
            out[uint256(p)] = 0;
            p -= 1;
        }
        return (out, take);
    }

    /// @dev Determine and stamp terminal conditions on a freshly-advanced state.
    ///      Called with `s.turn` already set to the player about to move.
    function _resolve(GameState memory s) private pure {
        // win by majority of seeds captured
        if (s.store0 > SEEDS / 2) {
            _finish(s);
            return;
        }
        if (s.store1 > SEEDS / 2) {
            _finish(s);
            return;
        }

        uint8 ownSum = _rowSum(s.pits, s.turn);

        if (ownSum == 0) {
            // player to move has no seeds: the opponent collects all that remain
            uint8 oppSum = _rowSum(s.pits, 1 - s.turn);
            if (s.turn == 0) {
                s.store1 += oppSum;
            } else {
                s.store0 += oppSum;
            }
            _zeroBoard(s);
            _finish(s);
            return;
        }

        uint8 opp = _rowSum(s.pits, 1 - s.turn);
        if (opp == 0) {
            // opponent starved: if the mover cannot feed, the mover collects the board
            if (legalMovesMask(s) == 0) {
                if (s.turn == 0) {
                    s.store0 += ownSum;
                } else {
                    s.store1 += ownSum;
                }
                _zeroBoard(s);
                _finish(s);
                return;
            }
        }

        // Endless cyclic position guard: neither side has captured in a long
        // time, so split the board and end rather than let the game run forever.
        if (s.noCaptureCount >= NO_CAPTURE_LIMIT) {
            s.store0 += _rowSum(s.pits, 0);
            s.store1 += _rowSum(s.pits, 1);
            _zeroBoard(s);
            _finish(s);
        }
    }

    function _finish(GameState memory s) private pure {
        s.over = true;
        if (s.store0 > s.store1) {
            s.winner = 0;
        } else if (s.store1 > s.store0) {
            s.winner = 1;
        } else {
            s.winner = DRAW;
        }
    }

    function _zeroBoard(GameState memory s) private pure {
        for (uint8 i = 0; i < PITS; i++) {
            s.pits[i] = 0;
        }
    }

    /// @dev Sum of seeds in `player`'s six houses.
    function _rowSum(uint8[12] memory pits, uint8 player) private pure returns (uint8 total) {
        uint8 base = player == 0 ? 0 : HOUSES_PER_SIDE;
        for (uint8 h = 0; h < HOUSES_PER_SIDE; h++) {
            total += pits[base + h];
        }
    }
}
