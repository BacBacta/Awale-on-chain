import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { RedisMatchStore, type RedisLike } from "../src/persistence/redis-store.js";
import type { MatchRecord } from "../src/persistence/store.js";

// Minimal in-memory fake satisfying RedisLike (strings + sets), enough to verify
// the store's behaviour and the bigint-safe (de)serialization without a live Redis.
class FakeRedis implements RedisLike {
  private kv = new Map<string, string>();
  private sets = new Map<string, Set<string>>();
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
const B: Address = "0x000000000000000000000000000000000000000b";

function record(matchId: bigint, players: [Address, Address], updatedAt: number): MatchRecord {
  return {
    snapshot: {
      matchId,
      chainId: 31337n,
      verifier: "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3",
      session0: A,
      session1: B,
      startTurn: 0,
      moves: [2, 3],
      sigs: ["0xaa", "0xbb"],
    },
    players,
    mode: "casual",
    turn: 0,
    over: false,
    ply: 2,
    updatedAt,
  };
}

describe("RedisMatchStore", () => {
  it("round-trips a record (bigint matchId + snapshot) through redis strings", async () => {
    const store = new RedisMatchStore(new FakeRedis());
    await store.save(record(123n, [A, B], 1000));
    const got = await store.get("123");
    expect(got).not.toBeNull();
    expect(got!.snapshot.matchId).toBe(123n); // revived as a bigint
    expect(got!.snapshot.chainId).toBe(31337n);
    expect(got!.snapshot.moves).toEqual([2, 3]);
    expect(got!.players).toEqual([A, B]);
  });

  it("lists a player's matches newest-first and removes cleanly", async () => {
    const store = new RedisMatchStore(new FakeRedis());
    await store.save(record(1n, [A, B], 100));
    await store.save(record(2n, [A, B], 300));
    await store.save(record(3n, [A, B], 200));

    const forA = await store.listForPlayer(A);
    expect(forA.map((r) => r.snapshot.matchId)).toEqual([2n, 3n, 1n]); // by updatedAt desc

    await store.remove("2");
    const after = await store.listForPlayer(A);
    expect(after.map((r) => r.snapshot.matchId)).toEqual([3n, 1n]);
  });
});
