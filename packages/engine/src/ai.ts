// Awalé AI — negamax with alpha-beta pruning over the shared rule engine.
//
// Pure and deterministic given a seed; reused by the mini-app (Practice / Quick
// Match bot fallback) and available to the server. Difficulty is search depth
// plus a blunder rate so "easy" is genuinely beatable.

import { applyMove, legalMovesMask, DRAW, HOUSES_PER_SIDE, type GameState } from "./awale.js";

export type Difficulty = "easy" | "medium" | "hard";

const DEPTH: Record<Difficulty, number> = { easy: 2, medium: 5, hard: 8 };
const BLUNDER: Record<Difficulty, number> = { easy: 0.35, medium: 0.08, hard: 0 };
const WIN = 1_000_000;

function legalHouses(s: GameState): number[] {
  const mask = legalMovesMask(s);
  const out: number[] = [];
  for (let h = 0; h < HOUSES_PER_SIDE; h++) if (mask & (1 << h)) out.push(h);
  return out;
}

function rowSum(pits: number[], player: number): number {
  const base = player === 0 ? 0 : HOUSES_PER_SIDE;
  let t = 0;
  for (let h = 0; h < HOUSES_PER_SIDE; h++) t += pits[base + h];
  return t;
}

/** Heuristic value from the perspective of `player` (higher = better for player). */
function evaluate(s: GameState, player: number): number {
  if (s.over) {
    if (s.winner === DRAW) return 0;
    return s.winner === player ? WIN : -WIN;
  }
  const myStore = player === 0 ? s.store0 : s.store1;
  const oppStore = player === 0 ? s.store1 : s.store0;
  // captured seeds dominate; on-board control is a mild tie-breaker.
  let score = (myStore - oppStore) * 18;
  score += (rowSum(s.pits, player) - rowSum(s.pits, 1 - player)) * 1;
  // pressure: opponent houses at 1 or 2 are capture targets — reward threatening them.
  const oppBase = player === 0 ? HOUSES_PER_SIDE : 0;
  for (let h = 0; h < HOUSES_PER_SIDE; h++) {
    const v = s.pits[oppBase + h];
    if (v === 1 || v === 2) score += 2;
  }
  return score;
}

// A draw is only fair if the position roughly warrants it — the bot declines
// when its own evaluation says it's clearly ahead, so a losing player can't
// just call the game even to dodge a loss. Small enough that a genuinely
// balanced or cyclic-stuck position (the reason this exists) still gets through.
const DRAW_ACCEPT_THRESHOLD = 15;

/** Whether the bot, playing `botPlayer`, would accept a draw offer in state `s`. */
export function wouldAcceptDraw(s: GameState, botPlayer: number): boolean {
  if (s.over) return false;
  return evaluate(s, botPlayer) <= DRAW_ACCEPT_THRESHOLD;
}

/** Negamax: value for the side to move in `s`. */
function negamax(s: GameState, depth: number, alpha: number, beta: number): number {
  if (s.over || depth === 0) return evaluate(s, s.turn);
  let best = -Infinity;
  for (const h of legalHouses(s)) {
    const child = applyMove(s, h);
    const v = -negamax(child, depth - 1, -beta, -alpha);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break; // prune
  }
  return best === -Infinity ? evaluate(s, s.turn) : best;
}

/**
 * Pick a house (0..5, relative to the side to move) for the current player.
 * Returns -1 only if there are no legal moves (shouldn't happen mid-game).
 */
export function chooseMove(s: GameState, difficulty: Difficulty = "medium", rng: () => number = Math.random): number {
  const houses = legalHouses(s);
  if (houses.length === 0) return -1;
  if (houses.length === 1) return houses[0];
  if (rng() < BLUNDER[difficulty]) return houses[Math.floor(rng() * houses.length)];

  const depth = DEPTH[difficulty];
  let bestScore = -Infinity;
  const best: number[] = [];
  for (const h of houses) {
    const score = -negamax(applyMove(s, h), depth - 1, -Infinity, Infinity);
    if (score > bestScore) {
      bestScore = score;
      best.length = 0;
      best.push(h);
    } else if (score === bestScore) {
      best.push(h);
    }
  }
  return best[Math.floor(rng() * best.length)]; // random among equally-best
}
