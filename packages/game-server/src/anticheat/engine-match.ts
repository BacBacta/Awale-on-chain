// Engine-assistance detection (P2-7), ADVISORY ONLY.
//
// Session keys prove WHO signed a move, not WHO (or what) chose it. Since the
// repo ships its own minimax (packages/engine/ai.ts), a cheater could quietly
// play its moves. This replays a finished transcript through the SAME engine
// and measures, per player, how closely their moves track the engine's top
// choice. High agreement over many non-forced positions is a signal — nothing
// more.
//
// IMPORTANT: this is a signal, NOT a verdict. Awalé positions are often
// forcing, and a strong human legitimately plays engine-like moves; a
// near-solved endgame can push anyone's match rate up. False positives are a
// real risk, so a flag must never move money or trigger an automatic ban — the
// wiring feeds a profile flag + logs for human review only. Money is already
// settled on-chain and stays that way.

import { initialState, applyMove, legalMovesMask, HOUSES_PER_SIDE, type GameState } from "../../../engine/src/awale.js";
import { rankMoves } from "../../../engine/src/ai.js";

export interface EngineMatchOptions {
  /** Search depth for the reference ranking (must match across runs). */
  depth?: number;
  /** Minimum non-forced plies before a player can be flagged. */
  minPlies?: number;
  /** Match-rate at/above which a player is flagged. */
  threshold?: number;
  /** Plies with FEWER than this many legal moves are "forced" and excluded —
   *  playing the only sane move proves nothing. Default 3 (skip ≤2). */
  minLegalMoves?: number;
}

export const DEFAULT_ENGINE_MATCH: Required<EngineMatchOptions> = {
  depth: 6,
  minPlies: 25,
  threshold: 0.85,
  minLegalMoves: 3,
};

export interface PlayerEngineMatch {
  /** Non-forced plies this player made (the denominator). */
  considered: number;
  /** How many matched the engine's single top choice. */
  topMatches: number;
  /** topMatches / considered (0 when considered = 0). */
  matchRate: number;
  /** Mean 1-based rank of the played move among legal moves (1 = best). */
  meanRank: number;
  /** matchRate ≥ threshold AND considered ≥ minPlies. Advisory. */
  flagged: boolean;
}

export interface EngineMatchReport {
  perPlayer: [PlayerEngineMatch, PlayerEngineMatch];
  /** Plies replayed before the game ended / the transcript ran out. */
  pliesReplayed: number;
}

function legalCount(mask: number): number {
  let n = 0;
  for (let h = 0; h < HOUSES_PER_SIDE; h++) if (mask & (1 << h)) n++;
  return n;
}

/**
 * Replay `moves` (each a house 0..5 relative to the side to move) from the
 * initial position with the given `startTurn`, comparing every non-forced move
 * to the engine's ranking. Deterministic and pure — no I/O, same inputs give
 * the same report.
 */
export function analyzeTranscript(
  startTurn: 0 | 1,
  moves: readonly number[],
  opts: EngineMatchOptions = {},
): EngineMatchReport {
  const { depth, minPlies, threshold, minLegalMoves } = { ...DEFAULT_ENGINE_MATCH, ...opts };

  const acc = [
    { considered: 0, topMatches: 0, rankSum: 0 },
    { considered: 0, topMatches: 0, rankSum: 0 },
  ];

  let state: GameState = { ...initialState(), turn: startTurn };
  let pliesReplayed = 0;

  for (const move of moves) {
    if (state.over) break;
    const player = state.turn as 0 | 1;
    const mask = legalMovesMask(state);
    const nLegal = legalCount(mask);

    // only score genuine choices (skip forced/near-forced positions)
    if (nLegal >= minLegalMoves) {
      const ranked = rankMoves(state, depth); // best-first, deterministic
      const rank = ranked.indexOf(move); // 0-based; -1 if somehow illegal
      if (rank >= 0) {
        acc[player].considered += 1;
        acc[player].rankSum += rank + 1; // 1-based
        if (rank === 0) acc[player].topMatches += 1;
      }
    }

    // advance; stop cleanly if the transcript contains an illegal move
    try {
      state = applyMove(state, move);
    } catch {
      break;
    }
    pliesReplayed += 1;
  }

  const finalize = (a: (typeof acc)[number]): PlayerEngineMatch => {
    const matchRate = a.considered > 0 ? a.topMatches / a.considered : 0;
    const meanRank = a.considered > 0 ? a.rankSum / a.considered : 0;
    return {
      considered: a.considered,
      topMatches: a.topMatches,
      matchRate,
      meanRank,
      flagged: a.considered >= minPlies && matchRate >= threshold,
    };
  };

  return { perPlayer: [finalize(acc[0]), finalize(acc[1])], pliesReplayed };
}
