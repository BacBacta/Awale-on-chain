import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { Match, type MatchConfig } from "../src/match.js";
import { moveDigest } from "../src/eip712.js";
import { InMemoryLiveMatchStore, InMemoryLeaderboardStore } from "../src/store/memory.js";
import { RedisLiveMatchStore, type RedisLike } from "../src/store/redis.js";
import { snapshotToJson, snapshotFromJson } from "../src/store/serialize.js";
import { applyMatchResult } from "../src/rating.js";
import { DEFAULT_ELO } from "../src/store/types.js";

const VERIFIER: Address = "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3";
const CHAIN_ID = 31337n;
const acct0 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000a11ce0");
const acct1 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000b0b000");

function cfg(): MatchConfig {
  return { matchId: 5n, chainId: CHAIN_ID, verifier: VERIFIER, sessions: [acct0.address, acct1.address], startTurn: 0 };
}

async function playTwo(m: Match): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const player = m.turn as 0 | 1;
    const house = m.legalMoves()[0];
    const acct = player === 0 ? acct0 : acct1;
    const sig = await acct.sign({ hash: moveDigest(m.cfg.matchId, BigInt(m.ply), house, { chainId: CHAIN_ID, verifier: VERIFIER }) });
    await m.submitMove(player, house, sig);
  }
}

describe("Match snapshot / rehydrate", () => {
  it("rehydrates to an identical state and transcript", async () => {
    const m = new Match(cfg());
    await playTwo(m);
    const snap = m.snapshot();

    const r = Match.rehydrate(snap);
    expect(r.state).toEqual(m.state);
    expect(r.transcript()).toEqual(m.transcript());
    expect(r.ply).toBe(m.ply);
  });

  it("survives a JSON round-trip (bigint-safe)", async () => {
    const m = new Match(cfg());
    await playTwo(m);
    const round = snapshotFromJson(snapshotToJson(m.snapshot()));
    expect(round).toEqual(m.snapshot());
    expect(round.matchId).toBe(5n);
  });
});

describe("InMemoryLiveMatchStore", () => {
  it("saves, loads, lists, and removes snapshots", async () => {
    const store = new InMemoryLiveMatchStore();
    const m = new Match(cfg());
    await playTwo(m);
    await store.save(m.snapshot());

    expect((await store.load(5n))?.moves).toEqual(m.snapshot().moves);
    expect(await store.list()).toEqual([5n]);
    await store.remove(5n);
    expect(await store.load(5n)).toBeNull();
  });
});

describe("RedisLiveMatchStore", () => {
  it("round-trips through a fake Redis client", async () => {
    const map = new Map<string, string>();
    const fake: RedisLike = {
      async get(k) {
        return map.get(k) ?? null;
      },
      async set(k, v) {
        map.set(k, v);
      },
      async del(k) {
        map.delete(k);
      },
      async keys(pattern) {
        const prefix = pattern.replace(/\*$/, "");
        return [...map.keys()].filter((k) => k.startsWith(prefix));
      },
    };
    const store = new RedisLiveMatchStore(fake);
    const m = new Match(cfg());
    await playTwo(m);
    await store.save(m.snapshot());

    expect(await store.list()).toEqual([5n]);
    const loaded = await store.load(5n);
    expect(loaded).toEqual(m.snapshot());
  });
});

describe("leaderboard + rating", () => {
  it("updates Elo and counters on a result", async () => {
    const store = new InMemoryLeaderboardStore();
    const [n0, n1] = await applyMatchResult(store, {
      matchId: 1n,
      winner: 0,
      player0: acct0.address,
      player1: acct1.address,
      timestamp: 1000,
    });

    expect(n0.elo).toBeGreaterThan(DEFAULT_ELO);
    expect(n1.elo).toBeLessThan(DEFAULT_ELO);
    expect(n0.wins).toBe(1);
    expect(n1.losses).toBe(1);

    const top = await store.top(10);
    expect(top[0].address).toBe(acct0.address);
    expect(top).toHaveLength(2);
  });

  it("counts a draw for both", async () => {
    const store = new InMemoryLeaderboardStore();
    const [n0, n1] = await applyMatchResult(store, {
      matchId: 2n,
      winner: 2,
      player0: acct0.address,
      player1: acct1.address,
      timestamp: 1000,
    });
    expect(n0.draws).toBe(1);
    expect(n1.draws).toBe(1);
    expect(n0.elo).toBe(DEFAULT_ELO); // equal ratings, draw -> unchanged
  });
});
