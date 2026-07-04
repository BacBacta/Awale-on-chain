import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  InMemoryCashPairStore,
  RedisCashPairStore,
  recoverCashPairs,
  type CashPairRedisLike,
  type PersistedCashPair,
} from "../src/cash-pair-store.js";

const A: Address = "0x000000000000000000000000000000000000000A";
const B: Address = "0x000000000000000000000000000000000000000b";

class FakeHashRedis implements CashPairRedisLike {
  private h = new Map<string, string>();
  async hset(_k: string, field: string, value: string) {
    this.h.set(field, value);
  }
  async hdel(_k: string, ...fields: string[]) {
    for (const f of fields) this.h.delete(f);
  }
  async hgetall(_k: string) {
    return Object.fromEntries(this.h);
  }
}

const pair = (over: Partial<PersistedCashPair> = {}): PersistedCashPair => ({
  creator: A,
  joiner: B,
  stakeKey: "0xtok:1000000000000000000",
  createdAt: 1,
  ...over,
});

describe("CashPairStore (P1-4)", () => {
  for (const [name, make] of [
    ["in-memory", () => new InMemoryCashPairStore()],
    ["redis", () => new RedisCashPairStore(new FakeHashRedis())],
  ] as const) {
    describe(name, () => {
      it("puts, lists, and removes by creator address (case-insensitive)", async () => {
        const store = make();
        await store.put(pair({ matchId: "7" }));
        const listed = await store.list();
        expect(listed).toHaveLength(1);
        expect(listed[0].matchId).toBe("7");
        await store.remove(A.toLowerCase() as Address);
        expect(await store.list()).toHaveLength(0);
      });

      it("overwrites the same creator (re-persist with matchId)", async () => {
        const store = make();
        await store.put(pair()); // no matchId yet
        await store.put(pair({ matchId: "9" })); // created on-chain
        const listed = await store.list();
        expect(listed).toHaveLength(1);
        expect(listed[0].matchId).toBe("9");
      });
    });
  }

  describe("recoverCashPairs", () => {
    it("notifies BOTH players of each stale pair and clears the store", async () => {
      const store = new InMemoryCashPairStore();
      await store.put(pair({ creator: A, joiner: B, matchId: "7" }));
      const notified: PersistedCashPair[] = [];
      const n = await recoverCashPairs(store, (p) => notified.push(p));
      expect(n).toBe(1);
      expect(notified).toHaveLength(1);
      expect(notified[0].creator).toBe(A);
      expect(notified[0].joiner).toBe(B);
      expect(notified[0].matchId).toBe("7"); // so the abort can point at the match to cancel
      expect(await store.list()).toHaveLength(0); // cleared — won't fire again next boot
    });

    it("is a no-op on an empty store", async () => {
      expect(await recoverCashPairs(new InMemoryCashPairStore(), () => {})).toBe(0);
    });
  });
});
