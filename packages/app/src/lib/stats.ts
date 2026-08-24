// Server-side stats loader. Reads the public /stats snapshot from the indexer
// when configured (RPC + escrow address via env); otherwise returns an empty
// snapshot so the page still renders.

import { createPublicClient, http, type Address } from "viem";
import { celo, celoAlfajores } from "viem/chains";
import {
  indexEscrow,
  emptySnapshot,
  type ChainReader,
  type StatsSnapshot,
} from "../../../indexer/src/index.js";

export async function getStats(): Promise<StatsSnapshot> {
  const rpc = process.env.STATS_RPC_URL;
  const escrow = process.env.ESCROW_ADDRESS as Address | undefined;
  if (!rpc || !escrow) return emptySnapshot();

  try {
    const testnet = process.env.CELO_TESTNET === "true";
    const client = createPublicClient({ chain: testnet ? celoAlfajores : celo, transport: http(rpc) });
    const toBlock = await client.getBlockNumber();
    const fromBlock = BigInt(process.env.ESCROW_FROM_BLOCK ?? "0");

    const reader: ChainReader = {
      // viem's PublicClient satisfies these structurally; cast narrows the types
      getLogs: (a) => client.getLogs(a as never) as never,
      getBlock: (a) => client.getBlock(a),
    };

    // This runs at build/revalidate time — it must never throw, or the whole
    // deploy fails on an RPC hiccup (it did: forno serves only ~10k blocks of
    // history, and the escrow's deploy block aged out of that window). Try the
    // full range for RPCs that can do it, then the recent window forno allows,
    // and always fall back to an empty snapshot so the page renders.
    try {
      return await indexEscrow(reader, { address: escrow, fromBlock, toBlock });
    } catch {
      const recent = toBlock > 9_000n ? toBlock - 9_000n : 0n;
      return await indexEscrow(reader, { address: escrow, fromBlock: recent > fromBlock ? recent : fromBlock, toBlock });
    }
  } catch {
    return emptySnapshot();
  }
}

export interface OpsCounters {
  failedTxRate: number;
  topCountries: { country: string; count: number }[];
}

/**
 * Server-side operational counters (failed-tx rate, top countries) that the
 * on-chain indexer cannot derive: a reverted transaction emits no logs, and
 * geography never touches the chain at all.
 *
 * Never throws — /stats must render even when the game server is down, since
 * MiniPay's reviewers need the page reachable at all times.
 */
export async function getOpsCounters(): Promise<OpsCounters | null> {
  const base = process.env.NEXT_PUBLIC_SERVER_URL;
  if (!base) return null;
  try {
    const res = await fetch(`${base}/events`, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<OpsCounters>;
    return {
      failedTxRate: typeof body.failedTxRate === "number" ? body.failedTxRate : 0,
      topCountries: Array.isArray(body.topCountries) ? body.topCountries : [],
    };
  } catch {
    return null;
  }
}
