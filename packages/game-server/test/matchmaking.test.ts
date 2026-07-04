import { describe, it, expect } from "vitest";
import { Matchmaker } from "../src/matchmaking.js";
import type { Address } from "viem";

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

describe("Matchmaker", () => {
  it("queues the first player and pairs a close second", () => {
    const mm = new Matchmaker({ baseWindow: 100 });
    expect(mm.enqueue({ id: "a", address: addr(1), elo: 1000 })).toBeNull();
    expect(mm.queueSize).toBe(1);

    const pair = mm.enqueue({ id: "b", address: addr(2), elo: 1050 });
    expect(pair).not.toBeNull();
    expect(new Set([pair!.a.id, pair!.b.id])).toEqual(new Set(["a", "b"]));
    expect(mm.queueSize).toBe(0);
  });

  it("does not pair players outside the window", () => {
    const mm = new Matchmaker({ baseWindow: 100, windowGrowthPerSec: 0 });
    mm.enqueue({ id: "a", address: addr(1), elo: 1000 });
    expect(mm.enqueue({ id: "b", address: addr(2), elo: 1500 })).toBeNull();
    expect(mm.queueSize).toBe(2);
  });

  it("never pairs a wallet with itself (two tabs = free wins otherwise)", () => {
    const mm = new Matchmaker({ baseWindow: 100 });
    mm.enqueue({ id: "tab1", address: addr(1), elo: 1000 });
    expect(mm.enqueue({ id: "tab2", address: addr(1), elo: 1000 })).toBeNull(); // same wallet waits
    expect(mm.queueSize).toBe(2);
    // a genuine second player still matches immediately
    const pair = mm.enqueue({ id: "c", address: addr(2), elo: 1010 });
    expect(pair).not.toBeNull();
    expect(pair!.b.address).toBe(addr(1));
  });

  it("pairs with the closest-rated waiter", () => {
    // window 100: a(1000) and b(1190) are 190 apart so they don't pair with each
    // other, but c(1100) is within window of both -> picks the closer one (b).
    const mm = new Matchmaker({ baseWindow: 100, windowGrowthPerSec: 0 });
    mm.enqueue({ id: "a", address: addr(1), elo: 1000 });
    mm.enqueue({ id: "b", address: addr(2), elo: 1190 });
    expect(mm.queueSize).toBe(2);

    const pair = mm.enqueue({ id: "c", address: addr(3), elo: 1100 });
    expect(pair).not.toBeNull();
    expect(pair!.b.id).toBe("b"); // gap 90 beats gap 100
    expect(mm.queueSize).toBe(1); // "a" still waiting
  });

  it("widens the window as a player waits", () => {
    let clock = 0;
    const mm = new Matchmaker({ baseWindow: 100, windowGrowthPerSec: 10, now: () => clock });
    expect(mm.enqueue({ id: "a", address: addr(1), elo: 1000 })).toBeNull();

    // immediately, a 300-gap joiner cannot match
    clock = 0;
    // ...but after 40s of waiting, A's window is 100 + 400 = 500 and accepts it
    clock = 40_000;
    const pair = mm.enqueue({ id: "b", address: addr(2), elo: 1300 });
    expect(pair).not.toBeNull();
    expect(new Set([pair!.a.id, pair!.b.id])).toEqual(new Set(["a", "b"]));
  });

  it("removes a player from the queue", () => {
    const mm = new Matchmaker();
    mm.enqueue({ id: "a", address: addr(1), elo: 1000 });
    expect(mm.remove("a")).toBe(true);
    expect(mm.remove("a")).toBe(false);
    expect(mm.queueSize).toBe(0);
  });

  describe("sweep (P0-1: pair already-waiting players as windows widen)", () => {
    it("pairs two waiters once their widened windows overlap, with no third arrival", () => {
      let clock = 0;
      const mm = new Matchmaker({ baseWindow: 100, windowGrowthPerSec: 10, now: () => clock });
      // A(1000) and B(1300) both enqueue: gap 300 > base window 100, no match
      expect(mm.enqueue({ id: "a", address: addr(1), elo: 1000 })).toBeNull();
      expect(mm.enqueue({ id: "b", address: addr(2), elo: 1300 })).toBeNull();
      expect(mm.queueSize).toBe(2);
      // nothing yet at t=0
      expect(mm.sweep()).toEqual([]);
      // after 20s each window is 100 + 200 = 300 >= gap 300 → they pair
      clock = 20_000;
      const pairs = mm.sweep();
      expect(pairs).toHaveLength(1);
      expect(new Set([pairs[0].a.id, pairs[0].b.id])).toEqual(new Set(["a", "b"]));
      expect(mm.queueSize).toBe(0);
      // idempotent: an empty queue sweeps to nothing
      expect(mm.sweep()).toEqual([]);
    });

    it("is deterministic on equal gaps: address tie-break, stable across runs", () => {
      // Three players 150 apart (A<B<C by elo AND by address). At base window
      // 100 all three wait; at t=5s the window is 150 so A-B and B-C are both
      // eligible (gap 150) and share B. Same enqueuedAt (0), so the address key
      // decides: A-B (smallest addresses) wins, C is left waiting — every run.
      const mk = () => {
        let clock = 0;
        const mm = new Matchmaker({ baseWindow: 100, windowGrowthPerSec: 10, now: () => clock });
        mm.enqueue({ id: "A", address: addr(0x1), elo: 1000 });
        mm.enqueue({ id: "B", address: addr(0x2), elo: 1150 });
        mm.enqueue({ id: "C", address: addr(0x3), elo: 1300 });
        clock = 5000;
        return mm.sweep();
      };
      const a = mk();
      const b = mk();
      expect(a.map((p) => [p.a.id, p.b.id].sort())).toEqual(b.map((p) => [p.a.id, p.b.id].sort()));
      expect(a).toHaveLength(1);
      expect(new Set([a[0].a.id, a[0].b.id])).toEqual(new Set(["A", "B"]));
    });

    it("puts the earlier waiter first (a) — the cash creator is whoever waited longest", () => {
      // A enqueues at t=0, B at t=1s; both out of window until the sweep at
      // t=30s. `a` must be the earlier waiter (A) regardless of address order.
      let clock = 0;
      const mm = new Matchmaker({ baseWindow: 100, windowGrowthPerSec: 10, now: () => clock });
      mm.enqueue({ id: "first", address: addr(0x99), elo: 1000 }); // enqueuedAt 0, big address
      clock = 1000;
      mm.enqueue({ id: "second", address: addr(0x01), elo: 1300 }); // enqueuedAt 1000, small address
      clock = 30_000;
      const [pair] = mm.sweep();
      expect(pair.a.id).toBe("first"); // earlier enqueuedAt beats smaller address
      expect(pair.b.id).toBe("second");
    });

    it("never self-matches and leaves an unpairable waiter in the queue", () => {
      const mm = new Matchmaker({ baseWindow: 100, windowGrowthPerSec: 0 });
      mm.enqueue({ id: "tab1", address: addr(1), elo: 1000 });
      mm.enqueue({ id: "tab2", address: addr(1), elo: 1000 }); // same wallet
      mm.enqueue({ id: "lonely", address: addr(2), elo: 5000 }); // far out of window
      expect(mm.sweep()).toEqual([]);
      expect(mm.queueSize).toBe(3);
    });
  });

  describe("pairAnyoneAfterSec backstop (P0-2: cash/ranked liquidity floor)", () => {
    it("respects the base window, then pairs a huge gap once the backstop is reached", () => {
      // growth 0 so the ONLY way this gap ever pairs is the backstop — isolates it
      let clock = 0;
      const mm = new Matchmaker({ baseWindow: 200, windowGrowthPerSec: 0, pairAnyoneAfterSec: 120, now: () => clock });
      mm.enqueue({ id: "novice", address: addr(1), elo: 1200 });
      mm.enqueue({ id: "shark", address: addr(2), elo: 2000 }); // gap 800 ≫ window 200
      expect(mm.sweep()).toEqual([]); // t=0: no pair
      clock = 119_000;
      expect(mm.sweep()).toEqual([]); // just before the backstop: still no pair
      clock = 120_000;
      const pairs = mm.sweep(); // backstop reached: liquidity beats fairness
      expect(pairs).toHaveLength(1);
      expect(new Set([pairs[0].a.id, pairs[0].b.id])).toEqual(new Set(["novice", "shark"]));
    });

    it("is off by default (0): a lone huge gap never pairs", () => {
      let clock = 0;
      const mm = new Matchmaker({ baseWindow: 200, windowGrowthPerSec: 0, now: () => clock });
      mm.enqueue({ id: "novice", address: addr(1), elo: 1200 });
      mm.enqueue({ id: "shark", address: addr(2), elo: 2000 });
      clock = 10 * 60_000; // 10 minutes
      expect(mm.sweep()).toEqual([]);
    });
  });
});
