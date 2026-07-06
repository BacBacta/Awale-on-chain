import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  WeeklyLeague,
  InMemoryLeagueStore,
  weekKey,
  weekEndMs,
  PODIUM_BPS,
  computePrizes,
  type LeagueWinner,
} from "../src/weekly-league.js";

const A: Address = "0x000000000000000000000000000000000000000a";
const B: Address = "0x000000000000000000000000000000000000000b";
const C: Address = "0x000000000000000000000000000000000000000c";
const TOKEN: Address = "0x0000000000000000000000000000000000000123";

// Wednesday of one week, then any day of the next — for rollover tests.
const WED = new Date("2026-07-01T15:00:00Z"); // week of Monday 2026-06-29
const NEXT_TUE = new Date("2026-07-07T09:00:00Z"); // week of Monday 2026-07-06

const POT = 1_000_000_000_000_000_000n; // two 0.5-token stakes
const RAKE_BPS = 800;

function newLeague(opts: { minGames?: number; pairCap?: number } = {}) {
  return new WeeklyLeague(new InMemoryLeagueStore(), { poolShareBps: 5000, ...opts });
}

const payNobody = async () => [] as LeagueWinner[];
const payEveryone = async (_token: Address, winners: LeagueWinner[]) => winners;

describe("weekKey / weekEndMs", () => {
  it("maps any day to its Monday (UTC) and ends the following Monday", () => {
    expect(weekKey(WED)).toBe("2026-06-29");
    expect(weekKey(new Date("2026-06-29T00:00:00Z"))).toBe("2026-06-29"); // Monday maps to itself
    expect(weekKey(new Date("2026-07-05T23:59:59Z"))).toBe("2026-06-29"); // Sunday still the same week
    expect(weekEndMs("2026-06-29")).toBe(Date.parse("2026-07-06T00:00:00Z"));
  });
});

describe("WeeklyLeague.recordGame", () => {
  it("scores 3 for a win, 0 for a loss, and half the rake feeds the pool", async () => {
    const league = newLeague();
    await league.recordGame([A, B], 0, POT, RAKE_BPS, TOKEN, WED);

    const s = await league.snapshot(A, WED);
    // pool = pot * 8% rake * 50% share
    expect(BigInt(s.poolWei)).toBe((POT * 800n * 5000n) / 100_000_000n);
    expect(s.token).toBe(TOKEN);
    expect(s.me).toEqual({ rank: null, points: 3, games: 1, wins: 1 }); // rank null below minGames
    expect((await league.snapshot(B, WED)).me).toEqual({ rank: null, points: 0, games: 1, wins: 0 });
  });

  it("a draw scores ZERO (it pays no rake — points would be farmable for free) but still counts for eligibility", async () => {
    const league = newLeague();
    await league.recordGame([A, B], 2, POT, RAKE_BPS, TOKEN, WED);
    const s = await league.snapshot(A, WED);
    expect(s.poolWei).toBe("0");
    expect(s.me?.points).toBe(0);
    expect(s.me?.games).toBe(1);
  });

  it("referral bonuses add points, capped per referrer per week", async () => {
    const league = new WeeklyLeague(new InMemoryLeagueStore(), { refBonusCap: 2 });
    expect(await league.addReferralBonus(A, 2, WED)).toBe(true);
    expect(await league.addReferralBonus(A, 2, WED)).toBe(true);
    expect(await league.addReferralBonus(A, 2, WED)).toBe(false); // capped
    expect((await league.snapshot(A, WED)).me?.points).toBe(4);
  });

  it("past the per-opponent cap, games still count for eligibility but score nothing", async () => {
    const league = newLeague({ pairCap: 2, minGames: 3 });
    for (let i = 0; i < 3; i++) await league.recordGame([A, B], 0, POT, RAKE_BPS, TOKEN, WED);

    const s = await league.snapshot(A, WED);
    expect(s.me).toEqual({ rank: 1, points: 6, games: 3, wins: 3 }); // 2 scoring games, 3 played
    // a fresh opponent scores again
    await league.recordGame([A, C], 0, POT, RAKE_BPS, TOKEN, WED);
    expect((await league.snapshot(A, WED)).me?.points).toBe(9);
  });

  it("standings only rank players at the minimum games bar", async () => {
    const league = newLeague({ minGames: 2 });
    await league.recordGame([A, B], 0, POT, RAKE_BPS, TOKEN, WED);
    expect((await league.snapshot(undefined, WED)).standings).toEqual([]);
    await league.recordGame([A, B], 1, POT, RAKE_BPS, TOKEN, WED);
    const s = await league.snapshot(undefined, WED);
    // both at 2 games; B leads on points? A won game1 (3), B won game2 (3) — tie
    // on points and wins, fewer games ties too, address order decides
    expect(s.standings.map((r) => r.address)).toEqual([A, B]);
    expect(s.players).toBe(2);
  });
});

describe("WeeklyLeague.rollover", () => {
  it("first boot adopts the current week without paying", async () => {
    const league = newLeague();
    expect(await league.rollover(payEveryone, WED)).toBeNull();
    expect(await league.rollover(payEveryone, WED)).toBeNull(); // same week — nothing to do
  });

  it("a new week pays the standings per the bps schedule and resets the race", async () => {
    const league = newLeague({ minGames: 2 });
    await league.rollover(payEveryone, WED); // open the week
    // A beats B twice, B beats A once — A 6pts, B 3pts, both eligible
    await league.recordGame([A, B], 0, POT, RAKE_BPS, TOKEN, WED);
    await league.recordGame([A, B], 0, POT, RAKE_BPS, TOKEN, WED);
    await league.recordGame([A, B], 1, POT, RAKE_BPS, TOKEN, WED);
    const pool = (POT * 800n * 5000n / 100_000_000n) * 3n;

    let paidArgs: LeagueWinner[] = [];
    const result = await league.rollover(async (_t, w) => ((paidArgs = w), w), NEXT_TUE);

    expect(result?.week).toBe("2026-06-29");
    expect(paidArgs.map((w) => w.address)).toEqual([A, B]);
    expect(BigInt(paidArgs[0].amountWei)).toBe((pool * BigInt(PODIUM_BPS[0])) / 10_000n);
    expect(BigInt(paidArgs[1].amountWei)).toBe((pool * BigInt(PODIUM_BPS[1])) / 10_000n);

    // unpaid shares (ranks 3-5 empty) carry into the new week's pool
    const carried = pool - BigInt(paidArgs[0].amountWei) - BigInt(paidArgs[1].amountWei);
    const s = await league.snapshot(undefined, NEXT_TUE);
    expect(BigInt(s.poolWei)).toBe(carried);
    expect(s.standings).toEqual([]); // fresh race
    expect(s.lastWeek?.winners.length).toBe(2); // and the result is published

    expect(await league.rollover(payEveryone, NEXT_TUE)).toBeNull(); // idempotent
  });

  it("failed payouts carry the full pool forward instead of dropping it", async () => {
    const league = newLeague({ minGames: 1 });
    await league.rollover(payNobody, WED);
    await league.recordGame([A, B], 0, POT, RAKE_BPS, TOKEN, WED);
    const pool = (POT * 800n * 5000n) / 100_000_000n;

    const result = await league.rollover(payNobody, NEXT_TUE);
    expect(result?.winners).toEqual([]);
    expect(BigInt((await league.snapshot(undefined, NEXT_TUE)).poolWei)).toBe(pool);
  });
});

describe("computePrizes — podium + degressive dividend", () => {
  const std = (address: string, points: number) => ({ address: address as `0x${string}`, points, games: 5, wins: points / 3 });
  const POOL = 10_000_000n; // 10 units at 6 dp — keeps shares readable

  it("ranks 1-3 take 40/20/10, the rest split 30% pro-rata to points", () => {
    const ranked = [std("0xa", 15), std("0xb", 12), std("0xc", 9), std("0xd", 9), std("0xe", 6), std("0xf", 3)];
    const prizes = computePrizes(ranked, POOL);
    expect(prizes.map((p) => BigInt(p.amountWei))).toEqual([
      4_000_000n, // #1: 40%
      2_000_000n, // #2: 20%
      1_000_000n, // #3: 10%
      1_500_000n, // #4: 30% × 9/18
      1_000_000n, // #5: 30% × 6/18
      500_000n, // #6: 30% × 3/18
    ]);
    // nothing minted from thin air
    const total = prizes.reduce((a, p) => a + BigInt(p.amountWei), 0n);
    expect(total <= POOL).toBe(true);
  });

  it("dividend is degressive: better rank (more points) always gets more", () => {
    const ranked = [std("0xa", 30), std("0xb", 27), std("0xc", 24), std("0xd", 21), std("0xe", 9), std("0xf", 3)];
    const prizes = computePrizes(ranked, POOL).map((p) => BigInt(p.amountWei));
    for (let i = 4; i < prizes.length; i++) expect(prizes[i] < prizes[i - 1]).toBe(true);
  });

  it("fewer than 4 eligibles: podium only, the dividend is left for the carry", () => {
    const prizes = computePrizes([std("0xa", 6), std("0xb", 3)], POOL);
    expect(prizes.length).toBe(2);
    const total = prizes.reduce((a, p) => a + BigInt(p.amountWei), 0n);
    expect(total).toBe(6_000_000n); // 40% + 20% — the remaining 40% carries
  });

  it("zero-point tail (eligible via draws only) earns nothing — dividend carries", () => {
    const prizes = computePrizes([std("0xa", 9), std("0xb", 6), std("0xc", 3), std("0xd", 0)], POOL);
    expect(prizes.length).toBe(3);
  });

  it("empty standings → no prizes, whole pool carries", () => {
    expect(computePrizes([], POOL)).toEqual([]);
  });
});
