"use client";

// The weekly race card on Compete — the recurring money event. No sign-up, no
// bracket: cash games played this week count automatically, top 5 split the
// pot on Monday. One card tells a player the pot, where they stand, and what
// to do next; it renders nothing when the server (or the feature) is off.

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { getInjectedProvider, connect } from "../lib/minipay.js";
import { escrowConfig } from "../lib/escrow.js";
import { getWeeklyLeague, raceEndsIn, weeklyLeagueEnabled, type WeeklyLeagueSnapshot } from "../lib/weeklyLeague.js";
import { friendlyName } from "../lib/names.js";
import { fmt } from "../lib/money.js";

const STAKE_DECIMALS = Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "18");
const STAKE_SYMBOL = process.env.NEXT_PUBLIC_STAKE_SYMBOL ?? "USDC";
const MEDAL = ["#f6c863", "#cdd3da", "#cd8e5a"];
// once Self verification is live, prizes only pay out to verified humans —
// the card says so the week it turns on, not the Monday someone isn't paid
const SELF_CONFIGURED = Boolean(process.env.NEXT_PUBLIC_SELF_SCOPE && process.env.NEXT_PUBLIC_SELF_ENDPOINT);

export function WeeklyLeague() {
  const [data, setData] = useState<WeeklyLeagueSnapshot | null>(null);
  const [me, setMe] = useState<Address | null>(null);

  useEffect(() => {
    if (!weeklyLeagueEnabled()) return;
    let alive = true;
    (async () => {
      let address: Address | undefined;
      const p = getInjectedProvider();
      if (p) {
        try {
          address = (await connect(p, escrowConfig()?.chainId)).address as Address;
        } catch {
          /* not connected — show the race anonymously */
        }
      }
      if (address && alive) setMe(address);
      const s = await getWeeklyLeague(address);
      if (alive) setData(s);
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!data) return null;

  const pool = BigInt(data.poolWei);
  const entered = data.me !== null && data.me.games >= data.minGames;
  const played = data.me?.games ?? 0;
  const lastWinner = data.lastWeek?.winners[0];

  return (
    <>
      <span className="section-label">This week&apos;s race</span>
      <div className="card stack animate-in" style={{ gap: 10 }}>
        <div className="row">
          <span className="chip gold">🏁 Weekly league</span>
          <span className="faint">Ends in {raceEndsIn(data.endsAt)}</span>
        </div>

        {pool > 0n ? (
          <div className="row" style={{ alignItems: "baseline", gap: 6 }}>
            <span className="title score" style={{ color: "var(--gold)" }}>
              {fmt(pool, STAKE_DECIMALS)} {STAKE_SYMBOL}
            </span>
            <span className="faint">prize pot — top 5 share it Monday</span>
          </div>
        ) : (
          // a bare "0" pot reads as "dead app" — sell the mechanic instead
          <span className="muted">
            The pot grows with every money game played this week — top 5 share it Monday. Be first on the board.
          </span>
        )}

        {entered && data.me ? (
          <span className="muted">
            {data.me.rank !== null
              ? `You're #${data.me.rank} with ${data.me.points} pts (${data.me.wins} wins).`
              : `${data.me.points} pts so far — keep winning to enter the top 5.`}
          </span>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            <span className="muted">
              Play {data.minGames} money games this week to enter ({played}/{data.minGames} so far). Every game counts
              automatically.
            </span>
            <Link className="btn block" href="/?money=1">
              Play for money
            </Link>
          </div>
        )}

        {data.standings.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            {data.standings.slice(0, 5).map((r, i) => {
              const mine = me && r.address.toLowerCase() === me.toLowerCase();
              return (
                <div className="row" key={r.address} style={{ gap: 8 }}>
                  <span
                    style={{
                      color: i < 3 ? MEDAL[i] : "var(--faint)",
                      fontWeight: 800,
                      fontVariantNumeric: "tabular-nums",
                      width: 16,
                    }}
                  >
                    {i + 1}
                  </span>
                  <span style={{ flex: 1, fontWeight: 650, fontSize: 13.5 }}>
                    {friendlyName(r.address)} {mine && <span className="faint">(you)</span>}
                  </span>
                  <span className="faint" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {r.points} pts
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <span className="faint" style={{ fontSize: 11.5 }}>
          Win 3 pts · first {data.pairCap} games vs the same opponent count
          {SELF_CONFIGURED ? " · prizes require a one-time identity check" : ""}
          {lastWinner
            ? ` · last week ${friendlyName(lastWinner.address)} won ${fmt(BigInt(lastWinner.amountWei), STAKE_DECIMALS)} ${STAKE_SYMBOL}`
            : ""}
        </span>
      </div>
    </>
  );
}
