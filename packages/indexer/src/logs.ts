import type { Address } from "viem";
import type { EventRecord } from "./types.js";

/** MatchEscrow events the indexer consumes. */
export const escrowEventsAbi = [
  {
    type: "event",
    name: "MatchCreated",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "player0", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "stake", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MatchJoined",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "player1", type: "address", indexed: true },
      { name: "revealBlock", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MatchVoided",
    inputs: [{ name: "matchId", type: "uint256", indexed: true }],
  },
  {
    type: "event",
    name: "MatchSettled",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "winner", type: "uint8", indexed: false },
      { name: "prize", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "FeeCollected",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Celo RPCs reject eth_getLogs spans wider than ~50,000 blocks. */
export const MAX_LOG_SPAN = 50_000n;

/**
 * Split [fromBlock, toBlock] into inclusive windows no wider than `maxSpan`.
 * Pure — this is the core of the Celo pagination requirement.
 */
export function chunkRanges(fromBlock: bigint, toBlock: bigint, maxSpan = MAX_LOG_SPAN): [bigint, bigint][] {
  if (maxSpan < 1n) throw new Error("maxSpan must be >= 1");
  if (toBlock < fromBlock) return [];
  const ranges: [bigint, bigint][] = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = start + maxSpan - 1n;
    ranges.push([start, end > toBlock ? toBlock : end]);
    start = end + 1n;
  }
  return ranges;
}

interface DecodedLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
}

/** Minimal chain reader satisfied structurally by a viem PublicClient. */
export interface ChainReader {
  getLogs(args: {
    address: Address;
    events: typeof escrowEventsAbi;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<DecodedLog[]>;
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

function normalise(log: DecodedLog, timestamp: number): EventRecord | null {
  const a = log.args;
  switch (log.eventName) {
    case "MatchCreated":
      return {
        type: "created",
        matchId: a.matchId as bigint,
        player0: a.player0 as Address,
        token: a.token as Address,
        stake: a.stake as bigint,
        timestamp,
      };
    case "MatchJoined":
      return { type: "joined", matchId: a.matchId as bigint, player1: a.player1 as Address, timestamp };
    case "MatchSettled":
      return {
        type: "settled",
        matchId: a.matchId as bigint,
        winner: Number(a.winner as number | bigint),
        prize: a.prize as bigint,
        timestamp,
      };
    case "MatchVoided":
      return { type: "voided", matchId: a.matchId as bigint, timestamp };
    case "FeeCollected":
      return { type: "fee", matchId: a.matchId as bigint, token: a.token as Address, amount: a.amount as bigint, timestamp };
    default:
      return null;
  }
}

/**
 * Fetch and normalise all MatchEscrow events in [fromBlock, toBlock], paginating
 * eth_getLogs to stay within the Celo span limit and resolving (cached) block
 * timestamps.
 */
export async function fetchEscrowEvents(
  client: ChainReader,
  opts: { address: Address; fromBlock: bigint; toBlock: bigint; maxSpan?: bigint },
): Promise<EventRecord[]> {
  const ranges = chunkRanges(opts.fromBlock, opts.toBlock, opts.maxSpan ?? MAX_LOG_SPAN);
  const blockTs = new Map<bigint, number>();
  const out: EventRecord[] = [];

  for (const [from, to] of ranges) {
    const logs = await client.getLogs({ address: opts.address, events: escrowEventsAbi, fromBlock: from, toBlock: to });
    for (const log of logs) {
      let ts = blockTs.get(log.blockNumber);
      if (ts === undefined) {
        const block = await client.getBlock({ blockNumber: log.blockNumber });
        ts = Number(block.timestamp);
        blockTs.set(log.blockNumber, ts);
      }
      const rec = normalise(log, ts);
      if (rec) out.push(rec);
    }
  }
  return out;
}
