import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { InMemoryLeaguePrizeStore, RedisLeaguePrizeStore, type PendingPrize } from "../src/league-prizes.js";

const A = "0x00000000000000000000000000000000000000aa" as Address;
const prize = (amountWei: string, rank = 1): PendingPrize => ({ week: "2026-06-29", token: "0x0000000000000000000000000000000000000001" as Address, amountWei, rank });

function fakeRedis() {
  const m = new Map<string, string>();
  return {
    async get(k: string) {
      return m.get(k) ?? null;
    },
    async set(k: string, v: string) {
      m.set(k, v);
    },
    async del(k: string) {
      m.delete(k);
    },
  };
}

for (const [name, make] of [
  ["in-memory", () => new InMemoryLeaguePrizeStore()],
  ["redis", () => new RedisLeaguePrizeStore(fakeRedis())],
] as const) {
  describe(`LeaguePrizeStore (${name})`, () => {
    it("credits accumulate; take() empties atomically; second take pays nothing", async () => {
      const store = make();
      await store.credit(A, prize("100"));
      await store.credit(A, prize("50", 4));
      expect((await store.pending(A)).length).toBe(2);

      const taken = await store.take(A);
      expect(taken.map((p) => p.amountWei)).toEqual(["100", "50"]);
      expect(await store.take(A)).toEqual([]); // a double-tap can't double-pay
    });

    it("restore() puts the debt back after a failed transfer", async () => {
      const store = make();
      await store.credit(A, prize("100"));
      const taken = await store.take(A);
      await store.restore(A, taken);
      expect((await store.pending(A)).map((p) => p.amountWei)).toEqual(["100"]);
    });

    it("address lookup is case-insensitive", async () => {
      const store = make();
      await store.credit(A.toUpperCase().replace("0X", "0x") as Address, prize("7"));
      expect((await store.pending(A)).length).toBe(1);
    });
  });
}
