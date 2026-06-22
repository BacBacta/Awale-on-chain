import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { InMemorySocialStore, RedisSocialStore, type SocialStore } from "../src/social/store.js";
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
const B: Address = "0x000000000000000000000000000000000000000b";

function suite(name: string, make: () => SocialStore) {
  describe(name, () => {
    it("befriend is mutual", async () => {
      const s = make();
      await s.befriend(A, B);
      expect((await s.friends(A)).map((x) => x.toLowerCase())).toContain(B.toLowerCase());
      expect((await s.friends(B)).map((x) => x.toLowerCase())).toContain(A.toLowerCase());
    });

    it("challenges land in the recipient's inbox and can be dismissed", async () => {
      const s = make();
      await s.addChallenge(B, { id: "c1", from: A, matchId: "777", createdAt: 1 });
      let inbox = await s.challenges(B);
      expect(inbox).toHaveLength(1);
      expect(inbox[0].from.toLowerCase()).toBe(A.toLowerCase());
      expect(inbox[0].matchId).toBe("777");

      await s.removeChallenge(B, "c1");
      inbox = await s.challenges(B);
      expect(inbox).toHaveLength(0);
    });

    it("dedupes a re-challenge for the same match", async () => {
      const s = make();
      await s.addChallenge(B, { id: "c1", from: A, matchId: "777", createdAt: 1 });
      await s.addChallenge(B, { id: "c2", from: A, matchId: "777", createdAt: 2 });
      expect(await s.challenges(B)).toHaveLength(1);
    });
  });
}

suite("InMemorySocialStore", () => new InMemorySocialStore());
suite("RedisSocialStore", () => new RedisSocialStore(new FakeRedis()));
