import { describe, it, expect } from "vitest";
import { keccak256, type Hex } from "viem";
import { applyReveal, commitmentOf, RevealStore, STATUS_ACTIVE, type FlipCommitments } from "../src/flip-reveal.js";

const SECRET0 = keccak256("0xaa") as Hex;
const SECRET1 = keccak256("0xbb") as Hex;
const OTHER = keccak256("0xcc") as Hex;

const active: FlipCommitments = {
  status: STATUS_ACTIVE,
  commit0: commitmentOf(SECRET0),
  commit1: commitmentOf(SECRET1),
};

describe("commitmentOf", () => {
  it("is the contract's keccak256(abi.encode(secret))", () => {
    // abi.encode of a lone bytes32 is those same 32 bytes
    expect(commitmentOf(SECRET0)).toBe(keccak256(SECRET0));
  });
});

describe("applyReveal", () => {
  it("routes each secret to the half it proves", () => {
    expect(applyReveal(active, {}, SECRET0)).toMatchObject({ ok: true, slot: 0, ready: false });
    expect(applyReveal(active, {}, SECRET1)).toMatchObject({ ok: true, slot: 1, ready: false });
  });

  it("reports ready once both halves are in", () => {
    const first = applyReveal(active, {}, SECRET0);
    expect(first.ok && first.ready).toBe(false);
    const second = applyReveal(active, first.ok ? first.state : {}, SECRET1);
    expect(second).toMatchObject({ ok: true, ready: true, secret0: SECRET0, secret1: SECRET1 });
  });

  // a secret is its own credential: it is accepted only because it hashes to a
  // commitment the match already carries, so no signature is needed
  it("rejects a secret that matches neither commitment", () => {
    expect(applyReveal(active, {}, OTHER)).toEqual({ ok: false, reason: "unknown-secret" });
  });

  // THE ordering rule: before the match is Active player 1 has not committed,
  // and an early secret0 is exactly what a colluding joiner needs to grind
  // their own secret and choose who starts
  it("refuses any reveal while the match is not Active", () => {
    for (const status of [0, 1, 3, 4, 5, 6]) {
      expect(applyReveal({ ...active, status }, {}, SECRET0)).toEqual({ ok: false, reason: "not-active" });
    }
  });

  it("is idempotent — a retried reveal is not an error", () => {
    const once = applyReveal(active, {}, SECRET0);
    const twice = applyReveal(active, once.ok ? once.state : {}, SECRET0);
    expect(twice).toMatchObject({ ok: true, slot: 0, ready: false });
  });

  it("does not let one player fill both halves", () => {
    const once = applyReveal(active, {}, SECRET0);
    const twice = applyReveal(active, once.ok ? once.state : {}, SECRET0);
    expect(twice.ok && twice.ready).toBe(false);
  });
});

describe("RevealStore", () => {
  it("accumulates a pair across two calls and exposes it", () => {
    const store = new RevealStore();
    expect(store.pair(1n)).toBeNull();
    store.submit(1n, active, SECRET1);
    expect(store.pair(1n)).toBeNull();
    const done = store.submit(1n, active, SECRET0);
    expect(done).toMatchObject({ ok: true, ready: true });
    expect(store.pair(1n)).toEqual({ secret0: SECRET0, secret1: SECRET1 });
  });

  it("keeps matches independent", () => {
    const store = new RevealStore();
    store.submit(1n, active, SECRET0);
    store.submit(2n, active, SECRET1);
    expect(store.get(1n)).toEqual({ secret0: SECRET0 });
    expect(store.get(2n)).toEqual({ secret1: SECRET1 });
  });

  it("stores nothing when a reveal is rejected", () => {
    const store = new RevealStore();
    store.submit(1n, active, OTHER);
    store.submit(2n, { ...active, status: 1 }, SECRET0);
    expect(store.get(1n)).toEqual({});
    expect(store.get(2n)).toEqual({});
  });

  it("forgets a match once its flip is spent", () => {
    const store = new RevealStore();
    store.submit(1n, active, SECRET0);
    store.forget(1n);
    expect(store.get(1n)).toEqual({});
  });
});
