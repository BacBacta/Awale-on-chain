import { describe, it, expect, beforeEach } from "vitest";
import { keccak256 } from "viem";
import {
  newFlipSecret,
  commitmentOf,
  persistFlipSecret,
  loadFlipSecret,
  stashPendingSecret,
  claimPendingSecret,
} from "./flip.js";

// the suite runs in plain node (no jsdom), so stand up the smallest
// localStorage the module actually uses
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

describe("newFlipSecret", () => {
  it("is 32 bytes", () => {
    expect(newFlipSecret()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  // reuse is the one thing that breaks the scheme: a published secret lets the
  // opponent grind theirs to choose the outcome
  it("never repeats across matches", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newFlipSecret()));
    expect(seen.size).toBe(200);
  });
});

describe("commitmentOf", () => {
  it("matches the contract's keccak256(abi.encode(secret))", () => {
    // abi.encode of a lone bytes32 is just those 32 bytes, so the contract's
    // hash and a plain keccak of the secret must agree
    const secret = "0x".padEnd(66, "a") as `0x${string}`;
    expect(commitmentOf(secret)).toBe(keccak256(secret));
  });

  it("is deterministic", () => {
    const s = newFlipSecret();
    expect(commitmentOf(s)).toBe(commitmentOf(s));
  });

  it("hides the secret — different secrets give unrelated commitments", () => {
    expect(commitmentOf(newFlipSecret())).not.toBe(commitmentOf(newFlipSecret()));
  });
});

describe("persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a secret for a match", () => {
    const s = newFlipSecret();
    persistFlipSecret(7n, s);
    expect(loadFlipSecret(7n)).toBe(s);
  });

  it("returns null for a match it never stored", () => {
    expect(loadFlipSecret(99n)).toBeNull();
  });

  it("keeps matches separate", () => {
    const a = newFlipSecret();
    const b = newFlipSecret();
    persistFlipSecret(1n, a);
    persistFlipSecret(2n, b);
    expect(loadFlipSecret(1n)).toBe(a);
    expect(loadFlipSecret(2n)).toBe(b);
  });

  // createMatch only learns its id from the receipt, so the secret is stashed
  // first and re-keyed after
  it("re-keys a pending secret onto the match id", () => {
    const s = newFlipSecret();
    stashPendingSecret(s);
    expect(claimPendingSecret(42n)).toBe(s);
    expect(loadFlipSecret(42n)).toBe(s);
  });

  it("claiming twice does not resurrect a stale secret onto another match", () => {
    stashPendingSecret(newFlipSecret());
    claimPendingSecret(1n);
    expect(claimPendingSecret(2n)).toBeNull();
    expect(loadFlipSecret(2n)).toBeNull();
  });
});
