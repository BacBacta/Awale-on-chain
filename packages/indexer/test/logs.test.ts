import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { chunkRanges, fetchEscrowEvents, MAX_LOG_SPAN, escrowEventsAbi } from "../src/logs.js";

const ESCROW: Address = "0x00000000000000000000000000000000000e5c70";
const T: Address = "0x000000000000000000000000000000000000700a";
const A: Address = "0x000000000000000000000000000000000000000a";
const B: Address = "0x000000000000000000000000000000000000000b";

describe("chunkRanges (eth_getLogs pagination)", () => {
  it("splits into windows no wider than maxSpan", () => {
    const ranges = chunkRanges(0n, 99_999n, 50_000n);
    expect(ranges).toEqual([
      [0n, 49_999n],
      [50_000n, 99_999n],
    ]);
  });

  it("covers a non-aligned range fully and contiguously", () => {
    const ranges = chunkRanges(10n, 100_010n, 50_000n);
    expect(ranges).toEqual([
      [10n, 50_009n],
      [50_010n, 100_009n],
      [100_010n, 100_010n],
    ]);
  });

  it("handles a single block and an empty range", () => {
    expect(chunkRanges(5n, 5n)).toEqual([[5n, 5n]]);
    expect(chunkRanges(10n, 5n)).toEqual([]);
  });

  it("respects a tiny maxSpan", () => {
    expect(chunkRanges(0n, 2n, 1n)).toEqual([
      [0n, 0n],
      [1n, 1n],
      [2n, 2n],
    ]);
  });

  it("defaults to the Celo 50k span limit", () => {
    expect(MAX_LOG_SPAN).toBe(50_000n);
    expect(chunkRanges(0n, 49_999n).length).toBe(1);
    expect(chunkRanges(0n, 50_000n).length).toBe(2);
  });
});

describe("fetchEscrowEvents", () => {
  it("paginates, caches block timestamps, and normalises events", async () => {
    const logs = [
      { eventName: "MatchCreated", blockNumber: 10n, args: { matchId: 1n, player0: A, token: T, stake: 10n } },
      { eventName: "MatchJoined", blockNumber: 10n, args: { matchId: 1n, player1: B, startTurn: 0 } },
      { eventName: "MatchSettled", blockNumber: 60_000n, args: { matchId: 1n, winner: 0, prize: 19n } },
      { eventName: "FeeCollected", blockNumber: 110_000n, args: { matchId: 1n, token: T, amount: 1n } },
    ];

    const requested: [bigint, bigint][] = [];
    let getBlockCalls = 0;
    const client = {
      async getLogs(args: { fromBlock: bigint; toBlock: bigint }) {
        requested.push([args.fromBlock, args.toBlock]);
        return logs.filter((l) => l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock);
      },
      async getBlock(args: { blockNumber: bigint }) {
        getBlockCalls++;
        return { timestamp: args.blockNumber * 100n };
      },
    };

    const events = await fetchEscrowEvents(client, { address: ESCROW, fromBlock: 0n, toBlock: 120_000n });

    // 3 chunks, each within the span limit
    expect(requested.length).toBe(3);
    for (const [from, to] of requested) expect(to - from + 1n).toBeLessThanOrEqual(MAX_LOG_SPAN);

    // one getBlock per unique block (block 10 shared by two logs -> cached)
    expect(getBlockCalls).toBe(3);

    expect(events.map((e) => e.type)).toEqual(["created", "joined", "settled", "fee"]);
    expect(events[0]).toMatchObject({ type: "created", matchId: 1n, stake: 10n, timestamp: 1000 });
    expect(events[3]).toMatchObject({ type: "fee", amount: 1n, timestamp: 11_000_000 });
    // keep the ABI export referenced
    expect(escrowEventsAbi.length).toBe(5);
  });
});
