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
    async notify() {},
    async notifyTurn(address, matchId) {
      calls.push({ address, matchId });
    },
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

  describe("claimTimeout", () => {
    it("awards a walkover once the opponent's turn has been stale past the grace period", async () => {
      const { svc, id } = await newService(); // startTurn: 0 — it's A's turn
      const state = await svc.claimTimeout(id, 1, 0); // B claims, 0ms grace
      expect(state.over).toBe(true);
      expect(state.winner).toBe(1);
    });

    it("rejects claiming when it's your own turn", async () => {
      const { svc, id } = await newService();
      await expect(svc.claimTimeout(id, 0, 0)).rejects.toThrow("it's your turn");
    });

    it("rejects claiming before the grace period elapses", async () => {
      const { svc, id } = await newService();
      await expect(svc.claimTimeout(id, 1, 60_000)).rejects.toThrow("still has time");
    });

    it("rejects a second claim once the match is already over", async () => {
      const { svc, id } = await newService();
      await svc.claimTimeout(id, 1, 0);
      await expect(svc.claimTimeout(id, 1, 0)).rejects.toThrow("match over");
    });

    it("rejects a staked (cash) async match — that settles on-chain, not here", async () => {
      const { notifier } = spyNotifier();
      const svc = new AsyncMatchService(new InMemoryMatchStore(), notifier);
      const id = await svc.create({
        matchId: 43n,
        chainId: CHAIN_ID,
        verifier: VERIFIER,
        sessions: [s0.address, s1.address],
        players: [A, B],
        startTurn: 0,
        mode: "cash",
      });
      await expect(svc.claimTimeout(id, 1, 0)).rejects.toThrow("settle on-chain");
    });

    it("a tournament-style per-match clock overrides the global grace — both ways", async () => {
      const { svc, id } = await newService(); // startTurn: 0 — A on move
      // short leash set on the match: claimable now even though the caller
      // passes the huge correspondence default
      await svc.setTurnClock(id, 0);
      const state = await svc.claimTimeout(id, 1, 3 * 24 * 3600_000);
      expect(state.over).toBe(true);
      expect(state.winner).toBe(1);

      // and the reverse: a long per-match clock blocks a zero-grace call
      const second = await newService();
      await second.svc.setTurnClock(second.id, 60_000);
      await expect(second.svc.claimTimeout(second.id, 1, 0)).rejects.toThrow("still has time");
    });

    it("the per-match clock survives moves", async () => {
      const { svc, id } = await newService();
      await svc.setTurnClock(id, 600_000);
      const sig = await s0.sign({ hash: moveDigest(42n, 0n, 2, { chainId: CHAIN_ID, verifier: VERIFIER }) });
      await svc.move(id, 0, 2, sig);
      expect((await svc.getState(id))?.turnClockMs).toBe(600_000);
    });

    it("reports the walkover to the onResult hook (profiles/Elo feed)", async () => {
      const { notifier } = spyNotifier();
      const results: { players: [Address, Address]; winner: number }[] = [];
      const svc = new AsyncMatchService(new InMemoryMatchStore(), notifier, {
        onResult: (players, winner) => results.push({ players, winner }),
      });
      const id = await svc.create({
        matchId: 44n,
        chainId: CHAIN_ID,
        verifier: VERIFIER,
        sessions: [s0.address, s1.address],
        players: [A, B],
        startTurn: 0,
        mode: "casual",
      });
      await svc.claimTimeout(id, 1, 0); // player 0 timed out — B wins
      expect(results).toEqual([{ players: [A, B], winner: 1 }]);
    });
  });
});
