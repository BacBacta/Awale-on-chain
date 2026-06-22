import { describe, it, expect } from "vitest";
import { legalMovesMask } from "../../../engine/src/awale.js";
import { dailyPuzzle, captureGain } from "./daily.js";

function legal(s: ReturnType<typeof dailyPuzzle>["state"], h: number): boolean {
  return (legalMovesMask(s) & (1 << h)) !== 0;
}

describe("daily puzzle", () => {
  it("returns a solvable puzzle for many days (player to move, legal solution)", () => {
    for (const day of ["2026-06-22", "2026-01-01", "2026-12-31", "2027-03-15", "2025-07-04"]) {
      const p = dailyPuzzle(day);
      expect(p.state.over).toBe(false);
      expect(p.state.turn).toBe(0);
      expect(p.solution.length).toBeGreaterThan(0);
      for (const h of p.solution) expect(legal(p.state, h)).toBe(true);
      if (p.bestGain > 0) {
        // every solution move achieves the best capture
        for (const h of p.solution) expect(captureGain(p.state, h)).toBe(p.bestGain);
      }
    }
  });

  it("is deterministic per day", () => {
    const a = dailyPuzzle("2026-06-22");
    const b = dailyPuzzle("2026-06-22");
    expect(a.state.pits).toEqual(b.state.pits);
    expect(a.solution).toEqual(b.solution);
  });
});
