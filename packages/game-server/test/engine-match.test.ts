import { describe, it, expect } from "vitest";
import { analyzeTranscript } from "../src/anticheat/engine-match.js";
import { initialState, applyMove, legalMovesMask, HOUSES_PER_SIDE, type GameState } from "../../engine/src/awale.js";
import { rankMoves, chooseMove } from "../../engine/src/ai.js";

const DEPTH = 4; // shallower than default so the tests run fast; still deterministic

function legalHouses(s: GameState): number[] {
  const mask = legalMovesMask(s);
  const out: number[] = [];
  for (let h = 0; h < HOUSES_PER_SIDE; h++) if (mask & (1 << h)) out.push(h);
  return out;
}

/** Generate a full transcript where `move(state)` picks each move. */
function play(move: (s: GameState) => number, startTurn: 0 | 1 = 0, maxPlies = 200): number[] {
  let s: GameState = { ...initialState(), turn: startTurn };
  const moves: number[] = [];
  for (let i = 0; i < maxPlies && !s.over; i++) {
    const h = move(s);
    if (h < 0) break;
    moves.push(h);
    s = applyMove(s, h);
  }
  return moves;
}

// a seeded PRNG so "random" play is reproducible (no Math.random in tests that assert)
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("engine-match anti-cheat (P2-7)", () => {
  it("flags a player whose every move IS the engine's top choice", () => {
    // both sides play the engine's #1 move at the same depth we analyze at
    const moves = play((s) => rankMoves(s, DEPTH)[0]);
    const report = analyzeTranscript(0, moves, { depth: DEPTH, minPlies: 5 });
    // enough non-forced plies to judge, and both flagged at ~100% match
    expect(report.perPlayer[0].considered).toBeGreaterThanOrEqual(5);
    expect(report.perPlayer[0].matchRate).toBeGreaterThanOrEqual(0.85);
    expect(report.perPlayer[0].flagged).toBe(true);
    expect(report.perPlayer[1].flagged).toBe(true);
    expect(report.perPlayer[0].meanRank).toBeCloseTo(1, 5); // always the best move
  });

  it("does NOT flag random-legal play", () => {
    const rng = mulberry32(12345);
    const moves = play((s) => {
      const hs = legalHouses(s);
      return hs[Math.floor(rng() * hs.length)];
    });
    const report = analyzeTranscript(0, moves, { depth: DEPTH, minPlies: 5 });
    // a random player occasionally hits the top move by luck, but nowhere near
    // the 85% threshold, and their mean rank sits well below best
    expect(report.perPlayer[0].matchRate).toBeLessThan(0.85);
    expect(report.perPlayer[0].flagged).toBe(false);
    expect(report.perPlayer[1].flagged).toBe(false);
    expect(report.perPlayer[0].meanRank).toBeGreaterThan(1.2);
  });

  it("never flags a short game, however engine-like (not enough evidence)", () => {
    // a handful of perfect moves — under minPlies, so no flag
    const moves = play((s) => rankMoves(s, DEPTH)[0], 0, 8);
    const report = analyzeTranscript(0, moves, { depth: DEPTH, minPlies: 25 });
    expect(report.perPlayer[0].flagged).toBe(false);
    expect(report.perPlayer[1].flagged).toBe(false);
  });

  it("excludes forced plies (≤2 legal moves) from the denominator", () => {
    const moves = play((s) => rankMoves(s, DEPTH)[0]);
    const report = analyzeTranscript(0, moves, { depth: DEPTH, minPlies: 1, minLegalMoves: 99 });
    // with minLegalMoves so high, EVERY ply is "forced" and excluded
    expect(report.perPlayer[0].considered).toBe(0);
    expect(report.perPlayer[0].matchRate).toBe(0);
    expect(report.perPlayer[0].flagged).toBe(false);
  });

  it("is deterministic — identical inputs give an identical report", () => {
    const moves = play((s) => chooseMove(s, "medium", mulberry32(7)));
    const a = analyzeTranscript(0, moves, { depth: DEPTH });
    const b = analyzeTranscript(0, moves, { depth: DEPTH });
    expect(a).toEqual(b);
  });

  it("respects startTurn when replaying", () => {
    const moves = play((s) => rankMoves(s, DEPTH)[0], 1); // player 1 starts
    const report = analyzeTranscript(1, moves, { depth: DEPTH, minPlies: 5 });
    // player 1 made the first move, so it accrues the first "considered" ply
    expect(report.perPlayer[1].considered).toBeGreaterThan(0);
  });
});
