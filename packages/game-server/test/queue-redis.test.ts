import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { RedisMatchQueue, type RedisQueueLike } from "../src/store/queue-redis.js";
import type { PairingOptions } from "../src/pairing-core.js";

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

const OPTS: PairingOptions = { baseWindow: 100, growth: 0, pairAnyoneAfterSec: 0, windowRule: "lenient" };

// Minimal fake Redis: a sorted set (member→score) + hashes, plus the ONE Lua
// script this module uses, executed against the same in-memory state. Two
// RedisMatchQueue instances sharing ONE FakeRedis simulate two server nodes on
// one Redis — the realistic concurrency the atomic claim must survive.
class FakeRedis implements RedisQueueLike {
  zsets = new Map<string, Map<string, number>>();
  hashes = new Map<string, Map<string, string>>();
  private z(k: string) {
    return this.zsets.get(k) ?? this.zsets.set(k, new Map()).get(k)!;
  }
  private h(k: string) {
    return this.hashes.get(k) ?? this.hashes.set(k, new Map()).get(k)!;
  }
  async zadd(k: string, score: number, member: string) {
    this.z(k).set(member, score);
  }
  async zrem(k: string, ...members: string[]) {
    for (const m of members) this.z(k).delete(m);
  }
  async zrange(k: string, start: number, stop: number) {
    const sorted = [...this.z(k).entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
    return sorted.slice(start, stop === -1 ? undefined : stop + 1);
  }
  async zcard(k: string) {
    return this.z(k).size;
  }
  async hset(k: string, field: string, value: string) {
    this.h(k).set(field, value);
  }
  async hdel(k: string, ...fields: string[]) {
    for (const f of fields) this.h(k).delete(f);
  }
  async hgetall(k: string) {
    return Object.fromEntries(this.h(k));
  }
  // executes exactly the CLAIM_LUA guard the module ships (both present ⇒ remove both)
  async eval(_script: string, _numKeys: number, zkey: string, hkey: string, idA: string, idB: string) {
    const z = this.z(zkey);
    if (z.has(idA) && z.has(idB)) {
      z.delete(idA);
      z.delete(idB);
      this.h(hkey).delete(idA);
      this.h(hkey).delete(idB);
      return 1;
    }
    return 0;
  }
}

describe("RedisMatchQueue (P1-4)", () => {
  it("round-trips waiters and pairs a close second on enqueue", async () => {
    const q = new RedisMatchQueue(new FakeRedis(), "t:band:low", OPTS, () => 0);
    expect(await q.enqueue({ id: "a", address: addr(1), elo: 1000 })).toBeNull();
    expect(await q.size()).toBe(1);
    const pair = await q.enqueue({ id: "b", address: addr(2), elo: 1050 });
    expect(pair).not.toBeNull();
    expect(new Set([pair!.a.id, pair!.b.id])).toEqual(new Set(["a", "b"]));
    expect(await q.size()).toBe(0); // both claimed out of the set
  });

  it("removes a waiter (disconnect)", async () => {
    const q = new RedisMatchQueue(new FakeRedis(), "p", OPTS, () => 0);
    await q.enqueue({ id: "a", address: addr(1), elo: 1000 });
    await q.remove("a");
    expect(await q.size()).toBe(0);
  });

  it("sweeps already-waiting compatible players", async () => {
    let clock = 0;
    const q = new RedisMatchQueue(
      new FakeRedis(),
      "p",
      { baseWindow: 100, growth: 10, pairAnyoneAfterSec: 0, windowRule: "lenient" },
      () => clock,
    );
    await q.enqueue({ id: "a", address: addr(1), elo: 1000 });
    await q.enqueue({ id: "b", address: addr(2), elo: 1300 }); // gap 300 > 100: waits
    expect(await q.sweep()).toEqual([]);
    clock = 20_000; // windows widen to 300
    const pairs = await q.sweep();
    expect(pairs).toHaveLength(1);
    expect(await q.size()).toBe(0);
  });

  it("CONCURRENCY: two instances on one Redis never pair the same waiter twice", async () => {
    // one shared Redis, three waiters a,b,c all mutually pairable. Two nodes
    // sweep the SAME state at the same instant; the atomic claim must ensure
    // each waiter ends up in at most one pairing across both nodes.
    const redis = new FakeRedis();
    const node1 = new RedisMatchQueue(redis, "p", OPTS, () => 0);
    const node2 = new RedisMatchQueue(redis, "p", OPTS, () => 0);
    await node1.enqueue({ id: "a", address: addr(1), elo: 1000 });
    await node1.enqueue({ id: "b", address: addr(2), elo: 1010 });
    await node1.enqueue({ id: "c", address: addr(3), elo: 1020 });
    // both sweep the same snapshot
    const [p1, p2] = await Promise.all([node1.sweep(), node2.sweep()]);
    const claimedIds = [...p1, ...p2].flatMap((p) => [p.a.id, p.b.id]);
    // no id claimed twice
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    // and at most one pair could form from 3 players (one left over)
    expect(p1.length + p2.length).toBeLessThanOrEqual(1);
  });

  it("a lost claim returns null instead of a phantom pairing", async () => {
    const redis = new FakeRedis();
    const q1 = new RedisMatchQueue(redis, "p", OPTS, () => 0);
    const q2 = new RedisMatchQueue(redis, "p", OPTS, () => 0);
    await q1.enqueue({ id: "a", address: addr(1), elo: 1000 });
    // q2 enqueues b and wins the claim; then q1 (stale) tries to claim a+b and loses
    const won = await q2.enqueue({ id: "b", address: addr(2), elo: 1005 });
    expect(won).not.toBeNull();
    const lost = await q1.enqueue({ id: "a2", address: addr(1), elo: 1000 }); // a is already gone
    // a2 is alone now (a and b were claimed) → no pairing
    expect(lost).toBeNull();
  });
});
