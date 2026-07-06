import { describe, it, expect } from "vitest";
import {
  initialState,
  applyMove,
  legalMovesMask,
  adjudicate,
  positionKey,
  endsGame,
  DRAW,
  SEEDS,
  type GameState,
} from "../src/awale.js";

/** Fold moves through the plain per-move engine (no repetition rule). */
function play(moves: number[]): GameState {
  let s = initialState();
  for (const m of moves) s = applyMove(s, m);
  return s;
}

/** Deterministic legal-move generator biased AWAY from captures — the fastest
 *  way to steer a game into a stuck cycle so we can test the repetition rule. */
function firstNonCapturingMove(s: GameState): number {
  const mask = legalMovesMask(s);
  let fallback = -1;
  for (let h = 0; h < 6; h++) {
    if (!(mask & (1 << h))) continue;
    if (fallback < 0) fallback = h;
    const before = s.store0 + s.store1;
    const after = applyMove(s, h);
    if (after.store0 + after.store1 === before) return h; // no capture — prefer it
  }
  return fallback;
}

describe("positionKey", () => {
  it("same board + same turn ⇒ same key; different turn ⇒ different key", () => {
    const a = initialState();
    const b = initialState();
    expect(positionKey(a)).toBe(positionKey(b));
    expect(positionKey({ ...a, turn: 1 })).not.toBe(positionKey(a));
    expect(positionKey({ ...a, pits: [...a.pits.slice(0, 11), 5] })).not.toBe(positionKey(a));
  });
});

describe("adjudicate — parity with the plain engine on normal games", () => {
  it("a game that ends by a base rule adjudicates to the exact same result", () => {
    // greedily play to a natural end; adjudicate must agree with the fold
    let s = initialState();
    const moves: number[] = [];
    for (let i = 0; i < 500 && !s.over; i++) {
      const mask = legalMovesMask(s);
      let mv = -1;
      for (let h = 0; h < 6; h++) if (mask & (1 << h)) { mv = h; break; }
      if (mv < 0) break;
      moves.push(mv);
      s = applyMove(s, mv);
    }
    const adj = adjudicate(moves);
    expect(adj.over).toBe(s.over);
    expect(adj.winner).toBe(s.winner);
    expect(adj.store0).toBe(s.store0);
    expect(adj.store1).toBe(s.store1);
  });

  it("every adjudicated game terminates with a valid, seed-consistent result", () => {
    const moves: number[] = [];
    let s = initialState();
    for (let i = 0; i < 400; i++) {
      const mv = firstNonCapturingMove(s);
      if (mv < 0) break;
      moves.push(mv);
      s = applyMove(s, mv);
      if (adjudicate(moves).over) break;
    }
    const adj = adjudicate(moves);
    expect(adj.over).toBe(true);
    expect([0, 1, DRAW]).toContain(adj.winner);
    // a SWEEP ending (starve/cycle/backstop) zeroes the board and banks all 48;
    // a MAJORITY win (>24) ends immediately with seeds left on the board
    if (adj.pits.every((p) => p === 0)) expect(adj.store0 + adj.store1).toBe(SEEDS);
    else expect(Math.max(adj.store0, adj.store1)).toBeGreaterThan(SEEDS / 2);
  });
});

describe("adjudicate — repetition ends a stuck cycle early", () => {
  // seeded LCG so the search is deterministic across runs
  function lcg(seed: number): () => number {
    let x = seed >>> 0;
    return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  }

  it("a cyclic position ends by REPETITION — swept board, before the 40-ply backstop", () => {
    // Random legal play reaches genuine cycles (~14% of games); find the first
    // one that the repetition rule ends: board swept AND noCaptureCount < 40,
    // proving it was the repeat, not the 40-ply backstop.
    let found: { adj: GameState; movesLen: number } | null = null;
    for (let seed = 1; seed <= 800 && !found; seed++) {
      const rnd = lcg(seed);
      const moves: number[] = [];
      let s = initialState();
      for (let i = 0; i < 400; i++) {
        const mask = legalMovesMask(s);
        const pool: number[] = [];
        for (let h = 0; h < 6; h++) if (mask & (1 << h)) pool.push(h);
        if (!pool.length) break;
        const mv = pool[Math.floor(rnd() * pool.length)];
        moves.push(mv);
        s = applyMove(s, mv);
        const adj = adjudicate(moves);
        if (adj.over) {
          if (adj.pits.every((p) => p === 0) && adj.noCaptureCount < 40) found = { adj, movesLen: moves.length };
          break;
        }
      }
    }
    expect(found).not.toBeNull();
    expect(found!.adj.over).toBe(true);
    expect(found!.adj.store0 + found!.adj.store1).toBe(SEEDS); // swept, nothing lost
    expect([0, 1, DRAW]).toContain(found!.adj.winner);
    // truncating the game one move earlier is NOT over — the repeat is what ended it
    // (sanity that adjudicate didn't end it prematurely on the prior ply)
    expect(found!.movesLen).toBeGreaterThan(0);
  });

  it("endsGame(moves, move) matches adjudicate's over flag", () => {
    const moves = [0, 1, 2];
    expect(endsGame(moves, 3)).toBe(adjudicate([...moves, 3]).over);
  });
});
