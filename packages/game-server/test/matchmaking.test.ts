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
});
