import { describe, it, expect } from "vitest";
import { initialState, applyMove, legalMovesMask, type GameState } from "../src/awale.js";
import { chooseMove } from "../src/ai.js";

function legalHouses(s: GameState): number[] {
  const m = legalMovesMask(s);
  const out: number[] = [];
  for (let h = 0; h < 6; h++) if (m & (1 << h)) out.push(h);
  return out;
}

// deterministic rng for reproducible tests
function seeded(seed: number): () => number {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

describe("Awalé AI", () => {
  it("always returns a legal move", () => {
    let s = initialState();
    for (let i = 0; i < 30 && !s.over; i++) {
      const h = chooseMove(s, "medium", seeded(i + 1));
      expect(legalHouses(s)).toContain(h);
      s = applyMove(s, h);
    }
  });

  it("medium AI beats the placeholder bot (first legal move)", () => {
    // AI is player 0, the dumb bot is player 1
    let s = initialState();
    let guard = 0;
    while (!s.over && guard++ < 400) {
      const h = s.turn === 0 ? chooseMove(s, "medium", seeded(7)) : legalHouses(s)[0];
      s = applyMove(s, h);
    }
    expect(s.over).toBe(true);
    expect(s.store0).toBeGreaterThan(s.store1); // AI (player 0) wins
  });

  it("hard AI completes a move in reasonable time (depth 8 with pruning)", () => {
    const s = initialState();
    const t0 = Date.now();
    const h = chooseMove(s, "hard", seeded(3));
    expect(legalHouses(s)).toContain(h);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
