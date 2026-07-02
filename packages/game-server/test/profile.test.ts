import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  InMemoryProfileStore,
  RedisProfileStore,
  freshProfile,
  liveStreak,
  applyDailySolve,
  migrateLocalStreak,
  dayKey,
  prevDayKey,
  type ProfileStore,
} from "../src/profile/store.js";
import type { RedisLike } from "../src/persistence/redis-store.js";

class FakeRedis implements RedisLike {
  kv = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  async get(k: string) {
    return this.kv.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.kv.set(k, v);
  }
  async del(k: string) {
    this.kv.delete(k);
  }
  async sadd(k: string, m: string) {
    (this.sets.get(k) ?? this.sets.set(k, new Set()).get(k)!).add(m);
  }
  async srem(k: string, m: string) {
    this.sets.get(k)?.delete(m);
  }
  async smembers(k: string) {
    return [...(this.sets.get(k) ?? [])];
  }
}

const A: Address = "0x000000000000000000000000000000000000000A";

const NOW = new Date("2026-07-02T12:00:00Z");
const TODAY = dayKey(NOW); // 2026-07-02
const YESTERDAY = prevDayKey(NOW); // 2026-07-01

describe("streak logic", () => {
  it("first solve starts a streak of 1", () => {
    const p = applyDailySolve(freshProfile(A), NOW);
    expect(p.streak).toBe(1);
    expect(p.lastDailyDone).toBe(TODAY);
  });

  it("solving on consecutive days increments; re-solving today is idempotent", () => {
    let p = { ...freshProfile(A), streak: 3, lastDailyDone: YESTERDAY };
    p = applyDailySolve(p, NOW);
    expect(p.streak).toBe(4);
    expect(applyDailySolve(p, NOW).streak).toBe(4); // same day again — no change
  });

  it("a missed day resets to 1 on the next solve", () => {
    const p = applyDailySolve({ ...freshProfile(A), streak: 9, lastDailyDone: "2026-06-28" }, NOW);
    expect(p.streak).toBe(1);
  });

  it("liveStreak reports 0 once a day has been missed, without mutating", () => {
    const stale = { streak: 9, lastDailyDone: "2026-06-28" };
    expect(liveStreak(stale, NOW)).toBe(0);
    expect(liveStreak({ streak: 9, lastDailyDone: YESTERDAY }, NOW)).toBe(9);
    expect(liveStreak({ streak: 9, lastDailyDone: TODAY }, NOW)).toBe(9);
  });
});

describe("local-streak migration", () => {
  it("adopts a live device streak when the server has no history", () => {
    const p = migrateLocalStreak(freshProfile(A), { count: 12, lastDone: YESTERDAY }, NOW);
    expect(p.streak).toBe(12);
    expect(p.lastDailyDone).toBe(YESTERDAY);
  });

  it("refuses once the server has any history — the server wins", () => {
    const server = { ...freshProfile(A), streak: 2, lastDailyDone: YESTERDAY };
    const p = migrateLocalStreak(server, { count: 400, lastDone: YESTERDAY }, NOW);
    expect(p.streak).toBe(2);
  });

  it("refuses a dead local streak", () => {
    const p = migrateLocalStreak(freshProfile(A), { count: 30, lastDone: "2026-06-20" }, NOW);
    expect(p.streak).toBe(0);
    expect(p.lastDailyDone).toBe("");
  });

  it("then applyDailySolve continues the migrated streak", () => {
    let p = migrateLocalStreak(freshProfile(A), { count: 12, lastDone: YESTERDAY }, NOW);
    p = applyDailySolve(p, NOW);
    expect(p.streak).toBe(13);
  });
});

function storeSuite(name: string, make: () => ProfileStore) {
  describe(name, () => {
    it("round-trips a profile and lists its address", async () => {
      const s = make();
      const p = { ...freshProfile(A), streak: 5, lastDailyDone: TODAY, gamesPlayed: 7, gamesWon: 4 };
      await s.save(p);
      const got = await s.get(A);
      expect(got?.streak).toBe(5);
      expect(got?.gamesWon).toBe(4);
      expect((await s.list()).map((a) => a.toLowerCase())).toContain(A.toLowerCase());
    });

    it("returns null for an unknown address", async () => {
      expect(await make().get(A)).toBeNull();
    });
  });
}

storeSuite("InMemoryProfileStore", () => new InMemoryProfileStore());
storeSuite("RedisProfileStore", () => new RedisProfileStore(new FakeRedis()));
