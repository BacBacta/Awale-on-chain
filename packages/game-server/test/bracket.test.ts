import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  createBracket,
  pendingMatches,
  reportResult,
  isComplete,
  champion,
  finalStandings,
} from "../src/tournament/bracket.js";

const P = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

/** Always advance the lower-numbered address. */
function playOut(players: Address[]) {
  const b = createBracket(players);
  let guard = 0;
  while (!isComplete(b) && guard++ < 100) {
    for (const m of pendingMatches(b)) {
      const lower = BigInt(m.a) < BigInt(m.b) ? m.a : m.b;
      reportResult(b, m.round, m.index, lower);
    }
  }
  return b;
}

describe("bracket", () => {
  it("runs a clean 8-player single elimination to a champion", () => {
    const players = Array.from({ length: 8 }, (_, i) => P(i + 1));
    const b = playOut(players);
    expect(isComplete(b)).toBe(true);
    expect(champion(b)).toBe(P(1).toLowerCase());
    // 8 players → 3 rounds (4 + 2 + 1)
    expect(b.rounds.map((r) => r.length)).toEqual([4, 2, 1]);
  });

  it("handles a non-power-of-two field with byes (6 players)", () => {
    const players = Array.from({ length: 6 }, (_, i) => P(i + 1));
    const b = createBracket(players);
    // padded to 8: round 0 has 4 matches, two of them byes already decided
    expect(b.rounds[0].length).toBe(4);
    const decided = b.rounds[0].filter((m) => m.winner).length;
    expect(decided).toBe(2);
    const done = playOut(players);
    expect(isComplete(done)).toBe(true);
    expect(champion(done)).toBe(P(1).toLowerCase());
  });

  it("reports champion + runner-up as ordered standings", () => {
    const players = [P(1), P(2), P(3), P(4)];
    const b = playOut(players);
    const standings = finalStandings(b);
    expect(standings).toHaveLength(2);
    expect(standings[0]).toBe(P(1).toLowerCase()); // champion
    expect(standings[1].toLowerCase()).not.toBe(standings[0]); // distinct runner-up
  });

  it("rejects a winner who is not in the match", () => {
    const b = createBracket([P(1), P(2)]);
    const [m] = pendingMatches(b);
    expect(() => reportResult(b, m.round, m.index, P(99))).toThrow();
  });

  it("rejects deciding the same match twice", () => {
    const b = createBracket([P(1), P(2)]);
    reportResult(b, 0, 0, P(1));
    expect(() => reportResult(b, 0, 0, P(2))).toThrow();
  });

  it("only surfaces fully-seated matches as pending", () => {
    const b = createBracket([P(1), P(2), P(3), P(4)]);
    // round 0 has both semis seated; the final has nobody yet
    expect(pendingMatches(b)).toHaveLength(2);
    reportResult(b, 0, 0, P(1));
    // final still needs the other semi's winner
    expect(pendingMatches(b).some((m) => m.round === 1)).toBe(false);
  });
});
