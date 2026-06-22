// On-chain leaderboard: rank players by settled-match wins (and net winnings),
// derived from MatchSettled events + getMatch. Persistent and cross-player with
// no backend — the natural skill ladder for cash play. (Server ELO becomes the
// source of truth for casual/async ladders once persistence is wired.)

import { readContract, getLogs } from "viem/actions";
import { parseAbiItem, type Address } from "viem";
import { publicClient } from "./minipay.js";
import { matchEscrowAbi } from "../../../protocol/src/abis.js";
import type { EscrowConfig } from "./escrow.js";

const SETTLED = parseAbiItem("event MatchSettled(uint256 indexed matchId, uint8 winner, uint256 prize)");

export interface LeaderRow {
  address: Address;
  wins: number;
  net: bigint; // total prize won
}

export async function loadLeaderboard(cfg: EscrowConfig, limit = 25): Promise<LeaderRow[]> {
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
