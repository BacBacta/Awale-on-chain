import { CELO_MAINNET_TOKENS } from "../../protocol/src/tokens.js";
import { fetchEscrowEvents, type ChainReader } from "./logs.js";
import { computeStats } from "./stats.js";
import type { StatsSnapshot } from "./types.js";
import type { Address } from "viem";

export * from "./types.js";
export { chunkRanges, fetchEscrowEvents, escrowEventsAbi, MAX_LOG_SPAN, type ChainReader } from "./logs.js";
export { computeStats } from "./stats.js";

/** address(lowercase) -> stablecoin symbol, for labelling the per-token stats. */
export function tokenSymbolMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const t of Object.values(CELO_MAINNET_TOKENS)) map[t.token.toLowerCase()] = t.symbol;
  return map;
}

/** Fetch the MatchEscrow events and aggregate the public /stats snapshot. */
export async function indexEscrow(
  client: ChainReader,
  opts: { address: Address; fromBlock: bigint; toBlock: bigint; now?: number; maxSpan?: bigint },
): Promise<StatsSnapshot> {
  const events = await fetchEscrowEvents(client, opts);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  return computeStats(events, now, tokenSymbolMap());
}

/** An empty snapshot for when the indexer is not configured (no RPC/address). */
export function emptySnapshot(now = Math.floor(Date.now() / 1000)): StatsSnapshot {
  return {
    generatedAt: now,
    matches: { created: 0, settled: 0, voided: 0, open: 0 },
    uniquePlayers: 0,
    dau: 0,
    mau: 0,
    retention: { d1: 0, d7: 0, d30: 0 },
    perToken: [],
  };
}
