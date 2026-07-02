import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  InMemorySubscriptionStore,
  RedisSubscriptionStore,
  type SubscriptionStore,
  type WebPushSubscription,
} from "../src/notifications/notifier.js";
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

function sub(endpoint: string): WebPushSubscription {
  return { endpoint, keys: { p256dh: "p", auth: "a" } };
}

function suite(name: string, make: () => SubscriptionStore) {
  describe(name, () => {
    it("stores subscriptions, dedupes by endpoint, case-insensitive on address", async () => {
      const s = make();
      await s.add(A, sub("https://push/1"));
      await s.add(A, sub("https://push/1")); // duplicate endpoint — ignored
      await s.add(A, sub("https://push/2"));
      const list = await s.listFor(A.toLowerCase() as Address);
      expect(list.map((x) => x.endpoint).sort()).toEqual(["https://push/1", "https://push/2"]);
    });

    it("remove prunes one expired endpoint, keeping the rest", async () => {
      const s = make();
      await s.add(A, sub("https://push/1"));
      await s.add(A, sub("https://push/2"));
      await s.remove(A, "https://push/1");
      expect((await s.listFor(A)).map((x) => x.endpoint)).toEqual(["https://push/2"]);
    });
  });
}

suite("InMemorySubscriptionStore", () => new InMemorySubscriptionStore());
suite("RedisSubscriptionStore", () => new RedisSubscriptionStore(new FakeRedis()));
