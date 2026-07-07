"use client";

// The Weekly race card on Compete — the recurring money event. No sign-up, no
// bracket: cash games played this week count automatically and the pot splits
// by points on Monday. One card tells a player the pot, where they stand, and
// what to do next; it renders nothing when the server (or the feature) is off.
//
// Naming: player-facing this is the "Weekly race" (unit: pts, resets Monday) —
// never "league", which players confused with the Season (the no-loss savings
// feature at /league). Code/API identifiers keep the historical league name.

import { useEffect, useState } from "react";
import { STAKE_DECIMALS, STAKE_SYMBOL } from "../lib/stake.js";
import Link from "next/link";
import type { Address } from "viem";
import { getInjectedProvider, connect } from "../lib/minipay.js";
import { escrowConfig } from "../lib/escrow.js";
import { getWeeklyLeague, raceEndsIn, weeklyLeagueEnabled, type WeeklyLeagueSnapshot } from "../lib/weeklyLeague.js";
import { PrizeCollect } from "./PrizeCollect.js";
import { friendlyName } from "../lib/names.js";
import { fmt } from "../lib/money.js";

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

  return (
    <>
      {/* the win comes first — same collect surface as the home lobby, so a
          winner meets it in both places (renders nothing when none is pending) */}
      <PrizeCollect address={me} />
      <div className="card stack animate-in" style={{ gap: 14, padding: 18 }}>
        <div className="row">
          <span className="chip gold">🏁 Weekly race</span>
          <span className="faint">Ends in {raceEndsIn(data.endsAt)}</span>
        </div>

        {/* the pot is the hero — one big number */}
        {pool > 0n ? (
          <div className="col" style={{ gap: 2 }}>
            <span className="display" style={{ color: "var(--gold)", fontSize: 34, lineHeight: 0.95, fontVariantNumeric: "tabular-nums" }}>
              {fmt(pool, STAKE_DECIMALS)} {STAKE_SYMBOL}
            </span>
            <span className="faint">this week&apos;s pot · splits by points on Monday</span>
          </div>
        ) : (
          <span className="muted">Every money game this week grows the pot — it splits by points on Monday.</span>
        )}

        {entered && data.me ? (
          <span className="muted">
            {data.me.rank !== null
              ? `You're #${data.me.rank} with ${data.me.points} pts (${data.me.wins} wins).`
              : `${data.me.points} pts so far — keep winning — more points means a bigger share.`}
          </span>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            <span className="muted">
              Play {data.minGames} money games to enter — {played}/{data.minGames} so far, counted automatically.
            </span>
            <Link className="btn secondary block" href="/?money=1">
              Play for money
            </Link>
          </div>
        )}

        {/* THIS WEEK'S race standings (points) — the money event's own board,
            given real weight (top 5, gold points) so it reads as the headline
            it is, never as a footnote to the skill Ladder below. Always PRESENT
            (empty state included) so the race never looks like it has no board
            while the Ladder below is full. Self-labelled with the same
            metric·period caption pattern as the Ladder. */}
        <div className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ alignItems: "baseline" }}>
            <span className="section-label">Race standings</span>
            <span className="faint" style={{ fontSize: 10.5, letterSpacing: "0.4px", textTransform: "uppercase" }}>
              points · this week
            </span>
          </div>
          {data.standings.length === 0 ? (
            <span className="faint" style={{ fontSize: 12.5, padding: "2px 2px 0" }}>
              No points yet — the first win (3 pts) takes #1.
            </span>
          ) : (
            <div className="card flat" style={{ padding: 6, gap: 0 }}>
              {(() => {
                const top = data.standings.slice(0, 5);
                const myIdx = me ? data.standings.findIndex((r) => r.address.toLowerCase() === me.toLowerCase()) : -1;
                const StandingRow = ({ r, i }: { r: (typeof data.standings)[number]; i: number }) => {
                  const mine = me != null && r.address.toLowerCase() === me.toLowerCase();
                  return (
                    <div
                      className="row"
                      style={{
                        gap: 12,
                        padding: "11px 12px",
                        borderRadius: "var(--r-md)",
                        background: mine ? "var(--accent-soft)" : "transparent",
                        boxShadow: mine ? "inset 0 0 0 1px rgba(76,229,132,0.35)" : undefined,
                      }}
                    >
                      <span style={{ width: 22, textAlign: "center", fontWeight: 800, fontSize: i < 3 ? 15 : 13.5, color: MEDAL[i] ?? "var(--faint)", fontVariantNumeric: "tabular-nums" }}>
                        {i + 1}
                      </span>
                      <span style={{ flex: 1, fontWeight: 700, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
                        {friendlyName(r.address)}
                        {mine && <span style={{ color: "var(--accent)", fontWeight: 650 }}> · you</span>}
                      </span>
                      <span className="score" style={{ fontSize: 17, fontWeight: 750, color: "var(--gold)", fontVariantNumeric: "tabular-nums" }}>
                        {r.points} <span style={{ fontSize: 11, fontWeight: 600, color: "var(--faint)" }}>pts</span>
                      </span>
                    </div>
                  );
                };
                return (
                  <>
                    {top.map((r, i) => (
                      <StandingRow key={r.address} r={r} i={i} />
                    ))}
                    {myIdx >= 5 && (
                      <>
                        <div style={{ textAlign: "center", color: "var(--faint)", fontSize: 12, padding: "2px 0" }}>···</div>
                        <StandingRow r={data.standings[myIdx]} i={myIdx} />
                      </>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </div>

        {SELF_CONFIGURED && (
          <span className="faint" style={{ fontSize: 11.5 }}>
            Prizes require a one-time identity check.
          </span>
        )}
      </div>
    </>
  );
}
