"use client";

import { useEffect, useState } from "react";
import { readContract } from "viem/actions";
import { type Address } from "viem";
import { getInjectedProvider, connect, publicClient } from "../lib/minipay.js";
import { escrowConfig } from "../lib/escrow.js";
import { listLocalMatches, STATUS } from "../lib/matches.js";
import { fmt } from "../lib/money.js";
import { getProfile, rankFor } from "../lib/profile.js";
import { cachedOutcomes, scanSettled, type Outcome } from "../lib/outcomes.js";
import { matchEscrowAbi } from "../../../protocol/src/abis.js";

const STAKE_DECIMALS = Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "6");
const STAKE_SYMBOL = process.env.NEXT_PUBLIC_STAKE_SYMBOL ?? "USDC";

// Outcome lookup lives in lib/outcomes.ts now: cached forever per match
// (settled results are immutable) and scanned ONLY for Resolved ids — the old
// scan hunted cancelled/voided ids that never emitted MatchSettled, so it
// exhausted its whole 400k-block lookback on every single visit.

interface Stats {
  played: number;
  won: number;
  lost: number;
  drawn: number;
  inProgress: number;
  staked: bigint; // total ever staked across local matches
  net: bigint; // realised P&L on finished matches (prize-stake on wins, -stake on losses)
}

/** `hideRank` drops the rank/Elo row — used on the Profile page, whose hero
 *  card already shows it (no double rank). */
export function PlayerStats({ hideRank }: { hideRank?: boolean } = {}) {
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
      const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
        Promise.race([p, new Promise<T>((res) => setTimeout(() => res(fallback), ms))]);

      const provider = getInjectedProvider();
      let address: Address | null = null;
      if (provider) {
        try {
          // don't let a pending wallet prompt (common on desktop) hang the
          // whole section forever — cap it and carry on with public reads
          address = (await withTimeout(connect(provider, cfg.chainId), 5000, { address: null } as { address: Address | null })).address;
          if (!address) setConnected(false);
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

      // One parallel round of getMatch first (fast), THEN hunt logs only for
      // the Resolved ids whose outcome isn't already in the immutable cache.
      // Typically that's zero or one recent match — found within the first
      // window or two — where the old code re-walked 400k blocks every visit.
      const records = await withTimeout(
        Promise.all(
          ids.map((id) =>
            readContract(client, { address: cfg.escrow, abi: matchEscrowAbi, functionName: "getMatch", args: [id] })
              .then((m) => ({ id, m: m as { status: number; stake: bigint; player0: Address; player1: Address } }))
              .catch(() => null),
          ),
        ),
        8_000,
        [] as ({ id: bigint; m: { status: number; stake: bigint; player0: Address; player1: Address } } | null)[],
      );
      const resolvedIds = records.filter((r) => r !== null && Number(r.m.status) === STATUS.Resolved).map((r) => r!.id);
      const winnerOf = cachedOutcomes(resolvedIds);
      const missing = resolvedIds.filter((id) => !winnerOf.has(id.toString()));
      if (missing.length > 0) {
        const found = await withTimeout(scanSettled(client, cfg.escrow, missing), 10_000, new Map<string, Outcome>());
        for (const [k, v] of found) winnerOf.set(k, v);
      }

      const s: Stats = { played: 0, won: 0, lost: 0, drawn: 0, inProgress: 0, staked: 0n, net: 0n };
      for (const r of records) {
        if (!r) continue;
        const { id, m } = r;
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

      {!hideRank && tier && elo !== null && (
        <div className="card row" style={{ alignItems: "center" }}>
          <div className="col" style={{ gap: 1 }}>
            <span className="faint">Rank</span>
            <span style={{ fontWeight: 750, fontSize: 17 }}>
              {tier.icon} {tier.name}
            </span>
          </div>
          {/* the number is the RATING (labelled), the tier above is the RANK —
              same split as RankHero, so 1197 is never ambiguous */}
          <div className="col" style={{ alignItems: "flex-end", gap: 0 }}>
            <span className="title score" style={{ color: "var(--gold)", lineHeight: 1 }}>
              {elo}
            </span>
            <span className="faint" style={{ fontSize: 10, letterSpacing: "0.6px", textTransform: "uppercase" }}>
              rating
            </span>
          </div>
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
