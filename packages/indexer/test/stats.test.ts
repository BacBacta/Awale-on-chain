import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { computeStats } from "../src/stats.js";
import type { EventRecord } from "../src/types.js";

const DAY = 86_400;
const now = 1000 * DAY;

const A: Address = "0x000000000000000000000000000000000000000a";
const B: Address = "0x000000000000000000000000000000000000000b";
const T: Address = "0x000000000000000000000000000000000000700a";

const events: EventRecord[] = [
  { type: "created", matchId: 1n, player0: A, token: T, stake: 10n, timestamp: 1000 * DAY + 100 },
  { type: "joined", matchId: 1n, player1: B, timestamp: 1000 * DAY + 120 },
  { type: "created", matchId: 2n, player0: A, token: T, stake: 5n, timestamp: 990 * DAY },
  { type: "created", matchId: 3n, player0: A, token: T, stake: 7n, timestamp: 991 * DAY },
  { type: "settled", matchId: 1n, winner: 0, prize: 19n, timestamp: 1000 * DAY + 200 },
  { type: "fee", matchId: 1n, token: T, amount: 3n, timestamp: 1000 * DAY + 200 },
];

describe("computeStats", () => {
  const s = computeStats(events, now);

  it("counts matches by status", () => {
    expect(s.matches).toEqual({ created: 3, settled: 1, voided: 0, open: 2 });
  });

  it("counts unique players", () => {
    expect(s.uniquePlayers).toBe(2);
  });

  it("computes DAU and MAU over their windows", () => {
    expect(s.dau).toBe(2); // A and B active today
    expect(s.mau).toBe(2);
  });

  it("computes retention from first-seen cohorts", () => {
    // A first seen day 990, active again day 991 -> D1 retained; B not yet eligible
    expect(s.retention.d1).toBe(1);
    expect(s.retention.d7).toBe(0); // A not active on day 997
    expect(s.retention.d30).toBe(0); // nobody eligible (10 days elapsed)
  });

  it("aggregates volume (settled pot) and revenue (rake) per token", () => {
    expect(s.perToken).toHaveLength(1);
    expect(s.perToken[0].token).toBe(T.toLowerCase());
    expect(s.perToken[0].volume).toBe("20"); // 2 × stake of the one settled match
    expect(s.perToken[0].revenue).toBe("3");
  });

  it("labels tokens when a symbol map is supplied", () => {
    const labelled = computeStats(events, now, { [T.toLowerCase()]: "USDC" });
    expect(labelled.perToken[0].symbol).toBe("USDC");
  });
});
