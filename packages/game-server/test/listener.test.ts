import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { GameHub } from "../src/hub.js";
import { openMatchFromChain, watchMatchJoined, type ChainMatch, type EventWatcher } from "../src/listener.js";

const VERIFIER: Address = "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3";
const ESCROW: Address = "0x00000000000000000000000000000000000e5c70";
const S0: Address = "0x0000000000000000000000000000000000000005";
const S1: Address = "0x0000000000000000000000000000000000000006";
const ctx = { chainId: 31337n, verifier: VERIFIER };

describe("openMatchFromChain", () => {
  it("opens a match in the hub from its on-chain record", () => {
    const hub = new GameHub();
    const m: ChainMatch = { matchId: 9n, session0: S0, session1: S1, startTurn: 1 };
    openMatchFromChain(hub, m, ctx);

    const match = hub.get(9n);
    expect(match).toBeDefined();
    expect(match!.cfg.sessions).toEqual([S0, S1]);
    expect(match!.cfg.startTurn).toBe(1);
    expect(match!.turn).toBe(1);
  });
});

describe("watchMatchJoined", () => {
  it("reads the match and opens it when a join is observed", async () => {
    const hub = new GameHub();
    let captured: ((logs: { args: { matchId?: bigint } }[]) => void) | null = null;

    const client: EventWatcher = {
      watchContractEvent(args) {
        captured = args.onLogs;
        return () => {};
      },
    };

    const readMatch = async (matchId: bigint): Promise<ChainMatch> => ({
      matchId,
      session0: S0,
      session1: S1,
      startTurn: 0,
    });

    const unsub = watchMatchJoined(client, { escrow: ESCROW, ctx, readMatch }, hub);
    expect(typeof unsub).toBe("function");

    // simulate the chain emitting a MatchJoined log
    captured!([{ args: { matchId: 7n } }]);
    await Promise.resolve(); // let the readMatch microtask resolve

    expect(hub.get(7n)).toBeDefined();
    expect(hub.activeCount).toBe(1);
  });
});
