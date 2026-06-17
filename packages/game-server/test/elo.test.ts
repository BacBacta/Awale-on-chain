import { describe, it, expect } from "vitest";
import { expectedScore, updateElo, scoreForWinner } from "../src/elo.js";

describe("Elo", () => {
  it("expected score is 0.5 for equal ratings", () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5, 10);
  });

  it("favourite has expected score > 0.5", () => {
    expect(expectedScore(1700, 1500)).toBeGreaterThan(0.5);
  });

  it("winner gains and loser loses, symmetrically", () => {
    const [a, b] = updateElo(1500, 1500, 1);
    expect(a).toBeGreaterThan(1500);
    expect(b).toBeLessThan(1500);
    expect(a - 1500).toBe(1500 - b); // equal-rated: symmetric swing
  });

  it("a draw barely moves equal ratings", () => {
    const [a, b] = updateElo(1500, 1500, 0.5);
    expect(a).toBe(1500);
    expect(b).toBe(1500);
  });

  it("beating a higher-rated player gains more", () => {
    const [under] = updateElo(1400, 1800, 1);
    const [fav] = updateElo(1800, 1400, 1);
    expect(under - 1400).toBeGreaterThan(fav - 1800);
  });

  it("maps Awalé winners to player-0 scores", () => {
    expect(scoreForWinner(0)).toBe(1);
    expect(scoreForWinner(1)).toBe(0);
    expect(scoreForWinner(2)).toBe(0.5);
  });
});
