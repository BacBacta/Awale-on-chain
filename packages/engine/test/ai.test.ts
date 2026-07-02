import { describe, it, expect } from "vitest";
import { initialState, applyMove, legalMovesMask, type GameState } from "../src/awale.js";
import { chooseMove, wouldAcceptDraw } from "../src/ai.js";

function board(pits: number[], store0 = 0, store1 = 0, turn = 0): GameState {
  return { pits: pits.slice(), store0, store1, turn, over: false, winner: 0, noCaptureCount: 0 };
}

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

  describe("wouldAcceptDraw", () => {
    it("accepts a draw offer in a roughly even position", () => {
      const s = board([4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4], 10, 10, 0);
      expect(wouldAcceptDraw(s, 1)).toBe(true);
    });

    it("declines when the bot is clearly ahead on material", () => {
      // bot (player 1) is up by a large margin — it should keep playing for the win
      const s = board([4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4], 10, 20, 0);
      expect(wouldAcceptDraw(s, 1)).toBe(false);
    });

    it("accepts when the bot is behind", () => {
      const s = board([4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4], 20, 10, 0);
      expect(wouldAcceptDraw(s, 1)).toBe(true);
    });

    it("never accepts once the game is already over", () => {
      const s = { ...board([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 24, 24, 0), over: true, winner: 2 };
      expect(wouldAcceptDraw(s, 1)).toBe(false);
    });
  });
});
