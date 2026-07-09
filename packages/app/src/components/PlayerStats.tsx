"use client";

import { useEffect, useState } from "react";
import { STAKE_DECIMALS, STAKE_SYMBOL } from "../lib/stake.js";
import { stakeTokens } from "../lib/stakeTokens.js";
import { readContract } from "viem/actions";
import { type Address } from "viem";
import { getInjectedProvider, connect, publicClient } from "../lib/minipay.js";
import { escrowConfig, legacyEscrows } from "../lib/escrow.js";
import { listLocalMatches, STATUS } from "../lib/matches.js";
import { fmt } from "../lib/money.js";
import { getProfile, rankFor } from "../lib/profile.js";
import { cachedOutcomes, scanSettled, type Outcome } from "../lib/outcomes.js";
import { matchEscrowAbi } from "../../../protocol/src/abis.js";


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

// The stats compute walks every local match on-chain (getMatch + settled logs)
// — seconds on a slow RPC. Cache the last result so a revisit paints instantly
// and refreshes in the background instead of blocking on a ~20s spinner. Keyed
// with a version so a pre-token-filter cache can't repaint a stale wrong net.
const STATS_CACHE = "awale:statscache:v2";
function loadCachedStats(): Stats | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STATS_CACHE) : null;
    if (!raw) return null;
    const c = JSON.parse(raw) as Omit<Stats, "staked" | "net"> & { staked: string; net: string };
    return { ...c, staked: BigInt(c.staked), net: BigInt(c.net) };
  } catch {
    return null;
  }
}
function saveCachedStats(s: Stats): void {
  try {
    localStorage.setItem(STATS_CACHE, JSON.stringify({ ...s, staked: s.staked.toString(), net: s.net.toString() }));
  } catch {
    /* quota or SSR — the live compute still runs */
  }
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
    const cached = loadCachedStats();
    if (cached) setStats(cached); // instant paint from last visit; refreshed below
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
      // a player's history spans contract migrations — read the current escrow
      // AND any legacy ones, or a redeploy silently zeroes their stats. Each
      // local id belongs to ONE contract: the escrow where it exists and this
      // wallet is a player. First match wins (current escrow first).
      const escrows = [cfg.escrow, ...legacyEscrows()];
      const me = address?.toLowerCase();
      // Only THIS deployment's stake token counts. A device that also played
      // testnet games (a different, 18-dec token) must not fold those amounts
      // into the record — summing them formats the net in the wrong decimals
      // (an 18-dec value under a 6-dec config renders 10^12 off).
      const knownTokens = new Set(stakeTokens().map((t) => t.address.toLowerCase()));
      type Rec = { id: bigint; escrow: Address; m: { status: number; stake: bigint; token: Address; player0: Address; player1: Address } };
      const records = await withTimeout(
        Promise.all(
          ids.map(async (id): Promise<Rec | null> => {
            for (const esc of escrows) {
              try {
                const m = (await readContract(client, { address: esc, abi: matchEscrowAbi, functionName: "getMatch", args: [id] })) as Rec["m"];
                if (Number(m.status) === 0) continue; // None on this contract — try the next
                if (me && m.player0.toLowerCase() !== me && m.player1.toLowerCase() !== me) continue; // someone else's id here
                return { id, escrow: esc, m };
              } catch {
                /* try the next escrow */
              }
            }
            return null;
          }),
        ),
        9_000,
        [] as (Rec | null)[],
      );

      // resolve outcomes PER escrow (MatchSettled events are contract-scoped)
      const winnerOf = new Map<string, Outcome>();
      const byEscrow = new Map<Address, bigint[]>();
      for (const r of records) {
        if (r && Number(r.m.status) === STATUS.Resolved) byEscrow.set(r.escrow, [...(byEscrow.get(r.escrow) ?? []), r.id]);
      }
      for (const [esc, rids] of byEscrow) {
        const cached = cachedOutcomes(rids);
        for (const [k, v] of cached) winnerOf.set(k, v);
        const missing = rids.filter((id) => !cached.has(id.toString()));
        if (missing.length > 0) {
          const found = await withTimeout(scanSettled(client, esc, missing), 10_000, new Map<string, Outcome>());
          for (const [k, v] of found) winnerOf.set(k, v);
        }
      }

      const s: Stats = { played: 0, won: 0, lost: 0, drawn: 0, inProgress: 0, staked: 0n, net: 0n };
      for (const r of records) {
        if (!r) continue;
        const { id, m } = r;
        // skip foreign-token (e.g. leftover testnet) matches entirely — they
        // belong to a different currency and can't share this record's totals
        if (knownTokens.size > 0 && !knownTokens.has(m.token.toLowerCase())) continue;
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
      saveCachedStats(s);
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

      {/* scope label: these tiles count MONEY games settled from this device —
          without saying so, "15 played" sat next to the rank card's "18 games"
          (every match, all devices) and read as the app contradicting itself */}
      <div className="row" style={{ alignItems: "baseline" }}>
        <span className="section-label">Your money record</span>
        <span className="faint" style={{ fontSize: 11, letterSpacing: "0.4px", textTransform: "uppercase" }}>
          money games · this device
        </span>
      </div>

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
        <span className="col" style={{ gap: 1 }}>
          <span className="muted">Net winnings</span>
          <span className="faint" style={{ fontSize: 11 }}>
            prizes won − stakes lost
          </span>
        </span>
        <span className="title score" style={{ color: netPositive ? "var(--accent)" : "var(--danger)" }}>
          {netPositive ? "+" : "−"}
          {fmt(stats.net < 0n ? -stats.net : stats.net, STAKE_DECIMALS)} {STAKE_SYMBOL}
        </span>
      </div>
    </div>
  );
}
