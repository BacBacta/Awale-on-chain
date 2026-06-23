import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { AsyncMatchService } from "../src/async-match.js";
import { InMemoryMatchStore } from "../src/persistence/store.js";
import type { Notifier } from "../src/notifications/notifier.js";
import { moveDigest } from "../src/eip712.js";

const VERIFIER: Address = "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3";
const CHAIN_ID = 31337n;
const s0 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000a11ce0");
const s1 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000b0b000");
const A: Address = "0x000000000000000000000000000000000000000A";
const B: Address = "0x000000000000000000000000000000000000000b";

function spyNotifier() {
  const calls: { address: Address; matchId: string }[] = [];
  const notifier: Notifier = {
    async notifyTurn(address, matchId) {
      calls.push({ address, matchId });
    },
    async notifyChallenge() {},
  };
  return { notifier, calls };
}

async function newService() {
  const { notifier, calls } = spyNotifier();
  const svc = new AsyncMatchService(new InMemoryMatchStore(), notifier);
  const id = await svc.create({
    matchId: 42n,
    chainId: CHAIN_ID,
    verifier: VERIFIER,
    sessions: [s0.address, s1.address],
    players: [A, B],
    startTurn: 0,
    mode: "casual",
  });
  return { svc, calls, id };
}

describe("AsyncMatchService", () => {
  it("applies a signed move, persists, and notifies the opponent", async () => {
    const { svc, calls, id } = await newService();

    // player 0 plays house 2 (ply 0)
    const sig = await s0.sign({ hash: moveDigest(42n, 0n, 2, { chainId: CHAIN_ID, verifier: VERIFIER }) });
    const state = await svc.move(id, 0, 2, sig);

    expect(state.turn).toBe(1); // turn passed to the opponent
    expect(calls).toEqual([{ address: B, matchId: id }]); // B was nudged
  });

  it("rejects a move signed by the wrong key", async () => {
    const { svc, id } = await newService();
    const bad = await s1.sign({ hash: moveDigest(42n, 0n, 2, { chainId: CHAIN_ID, verifier: VERIFIER }) });
    await expect(svc.move(id, 0, 2, bad)).rejects.toThrow(/signature/);
  });

  it("survives a reload: state replays from the store, turn-flagged per player", async () => {
    const { svc, id } = await newService();
    const sig = await s0.sign({ hash: moveDigest(42n, 0n, 2, { chainId: CHAIN_ID, verifier: VERIFIER }) });
    await svc.move(id, 0, 2, sig);

    const st = await svc.getState(id);
    expect(st?.ply).toBe(1);
    expect(st?.turn).toBe(1);

    const forA = await svc.listForPlayer(A);
    const forB = await svc.listForPlayer(B);
    expect(forA[0].yourTurn).toBe(false); // A just moved
    expect(forB[0].yourTurn).toBe(true); // B is up
    expect(forB[0].opponent.toLowerCase()).toBe(A.toLowerCase());
  });
});
