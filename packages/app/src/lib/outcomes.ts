// Settled-match outcomes (winner + prize), shared by PlayerStats and the
// leaderboard fallback.
//
// Two rules make this fast where the old scans were slow:
//  1. An outcome is IMMUTABLE once a match is Resolved — so it's cached in
//     localStorage forever and each match is log-scanned at most once per
//     device, instead of re-walking 400k blocks on every visit.
//  2. Only Resolved matches ever emitted MatchSettled. Cancelled/voided/open
//     ids never resolve a log, and hunting for them forced the backward scan
//     to exhaust its whole lookback every single time.

import { getLogs, getBlockNumber } from "viem/actions";
import { parseAbiItem } from "viem";
import type { Address } from "viem";

export const SETTLED_EVENT = parseAbiItem("event MatchSettled(uint256 indexed matchId, uint8 winner, uint256 prize)");

const LOG_WINDOW = 9000n; // forno caps getLogs ranges (~10k blocks)
const MAX_LOOKBACK = 400_000n;

export interface Outcome {
  winner: number;
  prize: bigint;
}

/** Minimal storage surface — injectable for tests. */
export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function storage(): KV | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const keyOf = (id: bigint) => `awale.outcome.${id.toString()}`;

/** Cached outcomes for `ids` (settled matches never change — cache forever). */
export function cachedOutcomes(ids: bigint[], kv: KV | null = storage()): Map<string, Outcome> {
  const out = new Map<string, Outcome>();
  if (!kv) return out;
  for (const id of ids) {
    try {
      const raw = kv.getItem(keyOf(id));
      if (!raw) continue;
      const [w, p] = raw.split(":");
      out.set(id.toString(), { winner: Number(w), prize: BigInt(p) });
    } catch {
      /* corrupt entry — rescan will refill it */
    }
  }
  return out;
}

export function cacheOutcome(id: bigint, o: Outcome, kv: KV | null = storage()): void {
  try {
    kv?.setItem(keyOf(id), `${o.winner}:${o.prize.toString()}`);
  } catch {
    /* storage full/blocked — worst case we rescan next visit */
  }
}

/** Scan the chain backward in forno-sized windows for MatchSettled events.
 *  With `ids`, stops as soon as every id is found; found outcomes are cached.
 *  Never throws — a rejected window is skipped (partial beats nothing). */
export async function scanSettled(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  escrow: Address,
  ids?: bigint[],
  kv: KV | null = storage(),
): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  const need = ids ? new Set(ids.map((i) => i.toString())) : null;
  if (need && need.size === 0) return out;
  let tip: bigint;
  try {
    tip = await getBlockNumber(client);
  } catch {
    return out;
  }
  const floor = tip > MAX_LOOKBACK ? tip - MAX_LOOKBACK : 0n;
  let to = tip;
  while (to >= floor && (need === null || need.size > 0)) {
    const from = to > LOG_WINDOW ? to - LOG_WINDOW + 1n : 0n;
    try {
      const logs = await getLogs(client, {
        address: escrow,
        event: SETTLED_EVENT,
        ...(ids ? { args: { matchId: ids } } : {}),
        fromBlock: from,
        toBlock: to,
      });
      for (const l of logs) {
        const a = l.args as { matchId?: bigint; winner?: number; prize?: bigint };
        if (a.matchId == null) continue;
        const o = { winner: Number(a.winner), prize: a.prize ?? 0n };
        out.set(a.matchId.toString(), o);
        cacheOutcome(a.matchId, o, kv);
        need?.delete(a.matchId.toString());
      }
    } catch {
      /* skip a window the RPC rejected */
    }
    if (from === 0n) break;
    to = from - 1n;
  }
  return out;
}
