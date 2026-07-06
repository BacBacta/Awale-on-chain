// Money leaderboard: settled-match wins + net winnings per player.
//
// Served by the game server, which folds every MatchSettled event into a
// durable board as it happens (see settled-ledger.ts there). The old approach
// — scanning every log since block 0 and calling getMatch per match, from the
// phone, on every visit — is kept only as a fallback for when the server is
// unreachable: it still works, it's just O(matches) RPC calls on a metered
// connection.

import { readContract } from "viem/actions";
import type { Address } from "viem";
import { publicClient } from "./minipay.js";
import { scanSettled } from "./outcomes.js";
import { matchEscrowAbi } from "../../../protocol/src/abis.js";
import type { EscrowConfig } from "./escrow.js";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

export interface LeaderRow {
  address: Address;
  wins: number;
  /** TRUE net winnings: prizes received minus stakes lost — the same metric
   *  as the personal "Net winnings" card, so the board and a player's own
   *  record always tell one story. Can be negative when wins didn't cover
   *  the losses. */
  net: bigint;
}

export async function loadLeaderboard(cfg: EscrowConfig, limit = 25): Promise<LeaderRow[]> {
  if (SERVER_URL) {
    try {
      // 5s cap: a hanging fetch used to block the whole board for the
      // browser's default timeout (minutes) before even trying the fallback
      const res = await fetch(`${SERVER_URL}/money-leaderboard?n=${limit}`, { signal: AbortSignal.timeout(5000) });
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
  // bounded backward scan — the old [0, latest] getLogs is rejected outright
  // by forno (~10k-block cap), so this fallback always threw and the board
  // showed "no settled matches yet" even when there were plenty
  const outcomes = await scanSettled(client, cfg.escrow);

  const tally = new Map<string, { wins: number; net: bigint }>();
  const bump = (addr: string, dWins: number, dNet: bigint) => {
    const cur = tally.get(addr) ?? { wins: 0, net: 0n };
    tally.set(addr, { wins: cur.wins + dWins, net: cur.net + dNet });
  };
  for (const [idStr, o] of outcomes) {
    if (o.winner === 2) continue; // draw: both stakes refunded, nothing moves
    try {
      const m = (await readContract(client, {
        address: cfg.escrow,
        abi: matchEscrowAbi,
        functionName: "getMatch",
        args: [BigInt(idStr)],
      })) as { player0: Address; player1: Address; stake: bigint };
      // double-entry, same as the server ledger: winner up prize−stake
      // (their own stake came back inside the prize), loser down their stake
      const winner = (o.winner === 0 ? m.player0 : m.player1).toLowerCase();
      const loser = (o.winner === 0 ? m.player1 : m.player0).toLowerCase();
      bump(winner, 1, o.prize - m.stake);
      bump(loser, 0, -m.stake);
    } catch {
      /* skip */
    }
  }

  return [...tally.entries()]
    .filter(([, v]) => v.wins > 0) // a winners' board, not a loss registry
    .map(([address, v]) => ({ address: address as Address, wins: v.wins, net: v.net }))
    .sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : b.wins - a.wins))
    .slice(0, limit);
}
