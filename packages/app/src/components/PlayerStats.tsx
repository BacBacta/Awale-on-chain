"use client";

import { useEffect, useState } from "react";
import { readContract, getLogs } from "viem/actions";
import { parseAbiItem, type Address } from "viem";
import { getInjectedProvider, connect, publicClient } from "../lib/minipay.js";
import { escrowConfig } from "../lib/escrow.js";
import { listLocalMatches, STATUS } from "../lib/matches.js";
import { fmt } from "../lib/money.js";
import { getProfile, rankFor } from "../lib/profile.js";
import { matchEscrowAbi } from "../../../protocol/src/abis.js";

const STAKE_DECIMALS = Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "6");
const STAKE_SYMBOL = process.env.NEXT_PUBLIC_STAKE_SYMBOL ?? "USDC";
const SETTLED = parseAbiItem("event MatchSettled(uint256 indexed matchId, uint8 winner, uint256 prize)");

interface Stats {
  played: number;
  won: number;
  lost: number;
  drawn: number;
  inProgress: number;
  staked: bigint; // total ever staked across local matches
  net: bigint; // realised P&L on finished matches (prize-stake on wins, -stake on losses)
}

export function PlayerStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [connected, setConnected] = useState(true);
  // The ONE rating in the app: the server Elo, shown as the Seedling →
  // Grandmaster tier — same number and names as Compete and the ladder.
  const [elo, setElo] = useState<number | null>(null);

  useEffect(() => {
    const cfg = escrowConfig();
    const ids = listLocalMatches();
    if (!cfg || ids.length === 0) {
      setStats({ played: 0, won: 0, lost: 0, drawn: 0, inProgress: 0, staked: 0n, net: 0n });
      const p = getInjectedProvider();
      if (cfg && p)
        connect(p, cfg.chainId)
          .then(({ address }) => getProfile(address))
          .then((prof) => prof && prof.gamesPlayed > 0 && setElo(prof.elo))
          .catch(() => {});
      return;
    }
    (async () => {
      const provider = getInjectedProvider();
      let address: Address | null = null;
      if (provider) {
        try {
          address = (await connect(provider, cfg.chainId)).address;
        } catch {
          setConnected(false);
        }
      } else {
        setConnected(false);
      }
      if (address) {
        getProfile(address)
          .then((prof) => prof && prof.gamesPlayed > 0 && setElo(prof.elo))
          .catch(() => {});
      }
      const client = publicClient(cfg.rpcUrl, cfg.chainId);

      // one pass for the settled outcomes among our matches
      const winnerOf = new Map<string, { winner: number; prize: bigint }>();
      try {
        const logs = await getLogs(client, {
          address: cfg.escrow,
          event: SETTLED,
          args: { matchId: ids },
          fromBlock: 0n,
          toBlock: "latest",
        });
        for (const l of logs) {
          const a = l.args as { matchId?: bigint; winner?: number; prize?: bigint };
          if (a.matchId != null) winnerOf.set(a.matchId.toString(), { winner: Number(a.winner), prize: a.prize ?? 0n });
        }
      } catch {
        /* RPC may reject wide ranges — fall back to status-only counts */
      }

      const s: Stats = { played: 0, won: 0, lost: 0, drawn: 0, inProgress: 0, staked: 0n, net: 0n };
      for (const id of ids) {
        try {
          const m = (await readContract(client, {
            address: cfg.escrow,
            abi: matchEscrowAbi,
            functionName: "getMatch",
            args: [id],
          })) as { status: number; stake: bigint; player0: Address; player1: Address };
          const status = Number(m.status);
          s.staked += m.stake;
          if (status === STATUS.Open || status === STATUS.Active || status === STATUS.Proposed) {
            s.inProgress += 1;
            continue;
          }
          if (status !== STATUS.Resolved) continue; // cancelled/voided: not a played result
          s.played += 1;
          const settled = winnerOf.get(id.toString());
          if (!settled || !address) continue;
          const role = address.toLowerCase() === m.player0.toLowerCase() ? 0 : 1;
          if (settled.winner === 2) {
            s.drawn += 1;
          } else if (settled.winner === role) {
            s.won += 1;
            s.net += settled.prize - m.stake; // profit = prize received minus own stake
          } else {
            s.lost += 1;
            s.net -= m.stake;
          }
        } catch {
          /* one unreadable match (stale id, RPC blip) shouldn't hide the rest */
        }
      }
      setStats(s);
    })().catch(() =>
      // total failure: zeros beat an infinite "Loading…" spinner
      setStats({ played: 0, won: 0, lost: 0, drawn: 0, inProgress: 0, staked: 0n, net: 0n }),
    );
  }, []);

  if (!stats) {
    return (
      <div className="card">
        <span className="chip">
          <span className="dot pulse" />
          Loading your stats…
        </span>
      </div>
    );
  }

  const decided = stats.won + stats.lost;
  const winRate = decided > 0 ? Math.round((stats.won / decided) * 100) : null;
  const netPositive = stats.net >= 0n;
  const tier = elo !== null ? rankFor(elo) : null;

  const cells: { label: string; value: string; tone?: string }[] = [
    { label: "Played", value: String(stats.played) },
    { label: "Won", value: String(stats.won), tone: "var(--accent)" },
    { label: "Win rate", value: winRate === null ? "—" : `${winRate}%` },
    { label: "In progress", value: String(stats.inProgress) },
  ];

  return (
    <div className="stack" style={{ gap: 12 }}>
      {!connected && (
        <div className="row">
          <span className="chip">connect wallet for full stats</span>
        </div>
      )}

      {tier && elo !== null && (
        <div className="card row" style={{ alignItems: "center" }}>
          <div className="col" style={{ gap: 1 }}>
            <span className="faint">Rank</span>
            <span style={{ fontWeight: 750, fontSize: 17 }}>
              {tier.icon} {tier.name}
            </span>
          </div>
          <span className="title score" style={{ color: "var(--gold)" }}>
            {elo}
          </span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {cells.map((c) => (
          <div className="card" key={c.label} style={{ padding: 14 }}>
            <div className="title score" style={{ color: c.tone ?? "var(--text)" }}>
              {c.value}
            </div>
            <div className="faint">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="card row">
        <span className="muted">Net winnings</span>
        <span className="title score" style={{ color: netPositive ? "var(--accent)" : "var(--danger)" }}>
          {netPositive ? "+" : "−"}
          {fmt(stats.net < 0n ? -stats.net : stats.net, STAKE_DECIMALS)} {STAKE_SYMBOL}
        </span>
      </div>
    </div>
  );
}
