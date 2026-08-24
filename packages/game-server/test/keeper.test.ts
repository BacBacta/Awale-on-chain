import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { keeperActions, runKeeper, EscrowStatus, type KeeperMatch } from "../src/keeper.js";
import type { SettlementClient } from "../src/chain.js";

const now = 1_000_000;

describe("keeperActions", () => {
  it("finalizes a proposed match past its challenge window", () => {
    const matches: KeeperMatch[] = [
      { matchId: 1n, status: EscrowStatus.Proposed, challengeDeadline: now - 1, activeDeadline: 0 },
    ];
    expect(keeperActions(matches, now)).toEqual([{ matchId: 1n, action: "finalize" }]);
  });

  it("does not finalize before the window closes", () => {
    const matches: KeeperMatch[] = [
      { matchId: 1n, status: EscrowStatus.Proposed, challengeDeadline: now + 100, activeDeadline: 0 },
    ];
    expect(keeperActions(matches, now)).toEqual([]);
  });

  it("voids an active match past its TTL", () => {
    const matches: KeeperMatch[] = [
      { matchId: 2n, status: EscrowStatus.Active, challengeDeadline: 0, activeDeadline: now - 1 },
    ];
    expect(keeperActions(matches, now)).toEqual([{ matchId: 2n, action: "voidExpired" }]);
  });

  it("ignores resolved/open matches and unset deadlines", () => {
    const matches: KeeperMatch[] = [
      { matchId: 3n, status: EscrowStatus.Resolved, challengeDeadline: now - 1, activeDeadline: now - 1 },
      { matchId: 4n, status: EscrowStatus.Open, challengeDeadline: 0, activeDeadline: 0 },
      { matchId: 5n, status: EscrowStatus.Active, challengeDeadline: 0, activeDeadline: 0 }, // no TTL set
    ];
    expect(keeperActions(matches, now)).toEqual([]);
  });

  it("finalizes the first move once both halves are revealed", () => {
    const pending: KeeperMatch[] = [
      { matchId: 6n, status: EscrowStatus.Active, challengeDeadline: 0, activeDeadline: now + 1000, startTurn: 255, flipReady: false },
    ];
    // a half still outstanding -> nothing to submit
    expect(keeperActions(pending, now)).toEqual([]);

    const ready: KeeperMatch[] = [{ ...pending[0], flipReady: true }];
    expect(keeperActions(ready, now)).toEqual([{ matchId: 6n, action: "finalizeStart" }]);
  });

  // the regression against the old blockhash flip: readiness is now a property
  // of the reveals, not of chain height, so no window can expire and no
  // keeper delay can cost anyone their turn
  it("does not depend on block height", () => {
    const matches: KeeperMatch[] = [
      { matchId: 6n, status: EscrowStatus.Active, challengeDeadline: 0, activeDeadline: now + 1000, startTurn: 255, flipReady: true },
    ];
    // same answer no matter how long the match has sat unrevealed
    expect(keeperActions(matches, now)).toEqual([{ matchId: 6n, action: "finalizeStart" }]);
    expect(keeperActions(matches, now + 86_400)).toEqual([{ matchId: 6n, action: "finalizeStart" }]);
  });

  it("does not finalizeStart once startTurn is fixed", () => {
    const matches: KeeperMatch[] = [
      { matchId: 7n, status: EscrowStatus.Active, challengeDeadline: 0, activeDeadline: now + 1000, startTurn: 1, flipReady: true },
    ];
    expect(keeperActions(matches, now)).toEqual([]);
  });
});

describe("runKeeper", () => {
  it("dispatches each action to the settlement client", async () => {
    const calls: string[] = [];
    const client = {
      finalize: async (id: bigint) => {
        calls.push(`finalize:${id}`);
        return "0xfin" as Hex;
      },
      voidExpired: async (id: bigint) => {
        calls.push(`void:${id}`);
        return "0xvoid" as Hex;
      },
    } as unknown as SettlementClient;

    const hashes = await runKeeper(client, [
      { matchId: 1n, action: "finalize" },
      { matchId: 2n, action: "voidExpired" },
    ]);

    expect(calls).toEqual(["finalize:1", "void:2"]);
    expect(hashes).toEqual(["0xfin", "0xvoid"]);
  });
});

describe("idsToRescan", () => {
  // the tracked set is in-memory: a deploy wiped it and orphaned every live
  // match (frozen stakes #17…#46). The rescan must hand every unknown,
  // not-yet-terminal id back to the keeper.
  it("returns every id below next that is neither tracked nor terminal", async () => {
    const { idsToRescan } = await import("../src/keeper.js");
    const tracked = new Set(["2"]);
    const terminal = new Set(["3"]);
    expect(idsToRescan(6n, tracked, terminal)).toEqual(["1", "4", "5"]);
  });

  it("empty escrow or everything known → nothing to do", async () => {
    const { idsToRescan } = await import("../src/keeper.js");
    expect(idsToRescan(1n, new Set(), new Set())).toEqual([]);
    expect(idsToRescan(3n, new Set(["1", "2"]), new Set())).toEqual([]);
  });
});
