import { describe, it, expect } from "vitest";
import { cachedOutcomes, cacheOutcome, type KV } from "./outcomes.js";

function fakeKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe("outcome cache", () => {
  it("round-trips winner + prize exactly (bigint-safe)", () => {
    const kv = fakeKV();
    cacheOutcome(47n, { winner: 1, prize: 1840000000000000000n }, kv);
    const got = cachedOutcomes([47n], kv);
    expect(got.get("47")).toEqual({ winner: 1, prize: 1840000000000000000n });
  });

  it("only returns ids actually cached — missing ids stay scannable", () => {
    const kv = fakeKV();
    cacheOutcome(1n, { winner: 0, prize: 5n }, kv);
    const got = cachedOutcomes([1n, 2n, 3n], kv);
    expect(got.size).toBe(1);
    expect(got.has("2")).toBe(false);
  });

  it("a corrupt entry is skipped, not fatal", () => {
    const kv = fakeKV();
    kv.data.set("awale.outcome.9", "not-a-valid-entry");
    // BigInt("...") throws inside — the id must simply be absent
    expect(cachedOutcomes([9n], kv).has("9")).toBe(false);
  });

  it("null storage (SSR) degrades to empty, and caching is a no-op", () => {
    expect(cachedOutcomes([1n], null).size).toBe(0);
    expect(() => cacheOutcome(1n, { winner: 0, prize: 1n }, null)).not.toThrow();
  });
});
