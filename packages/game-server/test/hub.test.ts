import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { GameHub } from "../src/hub.js";
import { moveDigest, stateHash } from "../src/eip712.js";
const OPENING = { pits: Array(12).fill(4), store0: 0, store1: 0, turn: 0, noCaptureCount: 0 };

const VERIFIER: Address = "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3";
const CHAIN_ID = 31337n;
const acct0 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000a11ce0");
const acct1 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000b0b000");

describe("GameHub", () => {
  it("opens a match, applies a signed move, and tracks it", async () => {
    const hub = new GameHub();
    const cfg = {
      matchId: 7n,
      chainId: CHAIN_ID,
      verifier: VERIFIER,
      sessions: [acct0.address, acct1.address] as [Address, Address],
      startTurn: 0 as const,
    };
    hub.open(cfg);
    expect(hub.activeCount).toBe(1);

    const m = hub.get(7n)!;
    const house = m.legalMoves()[0];
    const sig = await acct0.sign({ hash: moveDigest(7n, 0n, house, stateHash(OPENING), { chainId: CHAIN_ID, verifier: VERIFIER }) });
    const state = await hub.move(7n, 0, house, sig);

    expect(state.turn).toBe(1);
    expect(hub.transcript(7n)!.moves).toEqual([house]);

    hub.close(7n);
    expect(hub.activeCount).toBe(0);
  });

  it("rejects opening the same match twice", () => {
    const hub = new GameHub();
    const cfg = {
      matchId: 1n,
      chainId: CHAIN_ID,
      verifier: VERIFIER,
      sessions: [acct0.address, acct1.address] as [Address, Address],
      startTurn: 0 as const,
    };
    hub.open(cfg);
    expect(() => hub.open(cfg)).toThrow("already open");
  });

  it("queues players via the matchmaker", () => {
    const hub = new GameHub();
    expect(hub.queue({ id: "a", address: acct0.address, elo: 1000 })).toBeNull();
    const pair = hub.queue({ id: "b", address: acct1.address, elo: 1020 });
    expect(pair).not.toBeNull();
  });

  it("forfeits a match — no signature needed, opponent wins", () => {
    const hub = new GameHub();
    hub.open({
      matchId: 9n,
      chainId: CHAIN_ID,
      verifier: VERIFIER,
      sessions: [acct0.address, acct1.address],
      startTurn: 0,
    });
    const state = hub.forfeit(9n, 0);
    expect(state.over).toBe(true);
    expect(state.winner).toBe(1);
  });

  it("throws forfeiting a match that doesn't exist", () => {
    const hub = new GameHub();
    expect(() => hub.forfeit(999n, 0)).toThrow("no such match");
  });
});

describe("GameHub snapshots (crash/deploy recovery)", () => {
  const cfg = {
    matchId: 42n,
    chainId: CHAIN_ID,
    verifier: VERIFIER,
    sessions: [acct0.address, acct1.address] as [Address, Address],
    startTurn: 0 as const,
  };

  it("persists on open and forfeit; a new hub restores the exact state", async () => {
    const { InMemoryLiveMatchStore } = await import("../src/store/memory.js");
    const store = new InMemoryLiveMatchStore();
    const hub = new GameHub(undefined, store);
    hub.open(cfg);
    // persistence is fire-and-forget — settle the microtask queue
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.load(42n)).not.toBeNull();

    // a forfeit ends the match without a move — the snapshot must carry it
    hub.forfeit(42n, 1);
    await new Promise((r) => setTimeout(r, 0));
    const snap = (await store.load(42n))!;
    expect(snap.terminal?.winner).toBe(0);

    // deploy simulation: a brand-new hub, restored from the store
    const hub2 = new GameHub(undefined, store);
    hub2.restore(snap);
    const m = hub2.get(42n)!;
    expect(m.state.over).toBe(true);
    expect(m.state.winner).toBe(0);
  });

  it("close() drops the snapshot too — settled matches don't linger", async () => {
    const { InMemoryLiveMatchStore } = await import("../src/store/memory.js");
    const store = new InMemoryLiveMatchStore();
    const hub = new GameHub(undefined, store);
    hub.open(cfg);
    await new Promise((r) => setTimeout(r, 0));
    hub.close(42n);
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.load(42n)).toBeNull();
  });
});
