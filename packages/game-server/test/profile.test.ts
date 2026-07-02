import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  InMemoryProfileStore,
  RedisProfileStore,
  freshProfile,
  liveStreak,
  applyDailySolve,
  migrateLocalStreak,
  applyGameResult,
  topByElo,
  dayKey,
  prevDayKey,
  type ProfileStore,
} from "../src/profile/store.js";
import { DEFAULT_ELO } from "../src/store/types.js";
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

describe("game results → Elo + counters", () => {
  const B: Address = "0x000000000000000000000000000000000000000b";

  it("winner gains what the loser drops; counters track played/won", () => {
    const [w, l] = applyGameResult(freshProfile(A), freshProfile(B), 0);
    expect(w.elo).toBeGreaterThan(DEFAULT_ELO);
    expect(l.elo).toBeLessThan(DEFAULT_ELO);
    expect(w.elo + l.elo).toBe(2 * DEFAULT_ELO); // zero-sum at equal ratings
    expect(w.gamesPlayed).toBe(1);
    expect(w.gamesWon).toBe(1);
    expect(l.gamesPlayed).toBe(1);
    expect(l.gamesWon).toBe(0);
  });

  it("a draw between equals moves nothing but counts the game", () => {
    const [a, b] = applyGameResult(freshProfile(A), freshProfile(B), 2);
    expect(a.elo).toBe(DEFAULT_ELO);
    expect(b.elo).toBe(DEFAULT_ELO);
    expect(a.gamesWon).toBe(0);
    expect(a.gamesPlayed).toBe(1);
    expect(b.gamesPlayed).toBe(1);
  });

  it("upsets transfer more than expected wins", () => {
    const underdog = { ...freshProfile(A), elo: 1100 };
    const favourite = { ...freshProfile(B), elo: 1400 };
    const [u] = applyGameResult(underdog, favourite, 0); // underdog wins
    const [f2] = applyGameResult({ ...freshProfile(A), elo: 1400 }, { ...freshProfile(B), elo: 1100 }, 0); // favourite wins
    expect(u.elo - 1100).toBeGreaterThan(f2.elo - 1400);
  });
});

describe("topByElo", () => {
  const B: Address = "0x000000000000000000000000000000000000000b";
  const C: Address = "0x000000000000000000000000000000000000000c";

  it("ranks by elo, hides players with zero games, respects n", () => {
    const players = [
      { ...freshProfile(A), elo: 1300, gamesPlayed: 4 },
      { ...freshProfile(B), elo: 1500, gamesPlayed: 2 },
      { ...freshProfile(C), elo: 1900, gamesPlayed: 0 }, // never played — invisible
    ];
    const top = topByElo(players, 10);
    expect(top.map((p) => p.elo)).toEqual([1500, 1300]);
    expect(topByElo(players, 1).map((p) => p.elo)).toEqual([1500]);
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

    it("fills fields missing from records saved by an older build", async () => {
      const s = make();
      // simulate a pre-elo record: save a full profile, then strip the field
      const legacy = { ...freshProfile(A), streak: 3 } as Partial<ReturnType<typeof freshProfile>>;
      delete legacy.elo;
      await s.save(legacy as ReturnType<typeof freshProfile>);
      const got = await s.get(A);
      expect(got?.elo).toBe(DEFAULT_ELO);
      expect(got?.streak).toBe(3);
    });
  });
}

storeSuite("InMemoryProfileStore", () => new InMemoryProfileStore());
storeSuite("RedisProfileStore", () => new RedisProfileStore(new FakeRedis()));
