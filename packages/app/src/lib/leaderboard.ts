// Money leaderboard: settled-match wins + net winnings per player.
//
// Served by the game server, which folds every MatchSettled event into a
// durable board as it happens (see settled-ledger.ts there). The old approach
// — scanning every log since block 0 and calling getMatch per match, from the
// phone, on every visit — is kept only as a fallback for when the server is
// unreachable: it still works, it's just O(matches) RPC calls on a metered
// connection.

import { readContract, getLogs } from "viem/actions";
import { parseAbiItem, type Address } from "viem";
import { publicClient } from "./minipay.js";
import { matchEscrowAbi } from "../../../protocol/src/abis.js";
import type { EscrowConfig } from "./escrow.js";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";
const SETTLED = parseAbiItem("event MatchSettled(uint256 indexed matchId, uint8 winner, uint256 prize)");

export interface LeaderRow {
  address: Address;
  wins: number;
  net: bigint; // total prize won
}

export async function loadLeaderboard(cfg: EscrowConfig, limit = 25): Promise<LeaderRow[]> {
  if (SERVER_URL) {
    try {
      const res = await fetch(`${SERVER_URL}/money-leaderboard?n=${limit}`);
      if (res.ok) {
        const { leaders } = (await res.json()) as { leaders: { address: Address; wins: number; netWei: string }[] };
        return leaders.map((l) => ({ address: l.address, wins: l.wins, net: BigInt(l.netWei) }));
      }
    } catch {
      /* server unreachable — fall back to scanning the chain directly */
    }
  }
  return loadLeaderboardFromChain(cfg, limit);
}

async function loadLeaderboardFromChain(cfg: EscrowConfig, limit: number): Promise<LeaderRow[]> {
  const client = publicClient(cfg.rpcUrl, cfg.chainId);
  const logs = await getLogs(client, { address: cfg.escrow, event: SETTLED, fromBlock: 0n, toBlock: "latest" });

  const tally = new Map<string, { wins: number; net: bigint }>();
  for (const l of logs) {
    const a = l.args as { matchId?: bigint; winner?: number; prize?: bigint };
    if (a.matchId == null || a.winner == null || a.winner === 2) continue; // skip draws
    try {
      const m = (await readContract(client, {
        address: cfg.escrow,
        abi: matchEscrowAbi,
        functionName: "getMatch",
        args: [a.matchId],
      })) as { player0: Address; player1: Address };
      const winner = (Number(a.winner) === 0 ? m.player0 : m.player1).toLowerCase();
      const cur = tally.get(winner) ?? { wins: 0, net: 0n };
      cur.wins += 1;
      cur.net += a.prize ?? 0n;
      tally.set(winner, cur);
    } catch {
      /* skip */
    }
  }

  return [...tally.entries()]
    .map(([address, v]) => ({ address: address as Address, wins: v.wins, net: v.net }))
    .sort((a, b) => b.wins - a.wins || (b.net > a.net ? 1 : -1))
    .slice(0, limit);
}
