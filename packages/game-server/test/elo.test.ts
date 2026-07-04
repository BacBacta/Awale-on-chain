import { describe, it, expect } from "vitest";
import { expectedScore, updateElo, updateEloPair, scoreForWinner, kFactor } from "../src/elo.js";

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

  describe("kFactor schedule (P1-5, FIDE-inspired)", () => {
    it("provisional players (under 30 games) use K=40", () => {
      expect(kFactor(0, 1200)).toBe(40);
      expect(kFactor(29, 1200)).toBe(40);
      expect(kFactor(29, 2500)).toBe(40); // provisional beats the elite rule
    });
    it("established elites (>=2100) use K=20", () => {
      expect(kFactor(30, 2100)).toBe(20);
      expect(kFactor(200, 2400)).toBe(20);
    });
    it("everyone else uses K=32", () => {
      expect(kFactor(30, 1200)).toBe(32);
      expect(kFactor(100, 2099)).toBe(32);
    });
  });

  describe("updateEloPair — per-player K", () => {
    it("a provisional beginner moves more than an established opponent from the same game", () => {
      // equal ratings, beginner (K=40) beats a veteran (K=32)
      const [beginner, veteran] = updateEloPair(1500, 1500, 1, 40, 32);
      expect(beginner - 1500).toBe(20); // 40 * (1 - 0.5)
      expect(1500 - veteran).toBe(16); // 32 * (0 - 0.5)  → -16
    });
    it("matches updateElo when both K are equal", () => {
      expect(updateEloPair(1400, 1800, 1, 32, 32)).toEqual(updateElo(1400, 1800, 1, 32));
    });
  });
});
