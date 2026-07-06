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
import { getWeeklyLeague, getPendingPrizes, claimPrizes, raceEndsIn, weeklyLeagueEnabled, type WeeklyLeagueSnapshot, type PendingPrize } from "../lib/weeklyLeague.js";
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
  // prize waiting to be collected (credited at Monday's rollover)
  const [prizes, setPrizes] = useState<PendingPrize[]>([]);
  const [prizeTotal, setPrizeTotal] = useState<bigint>(0n);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

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
      if (address) {
        getPendingPrizes(address)
          .then((p) => {
            if (alive) {
              setPrizes(p.prizes);
              setPrizeTotal(p.totalWei);
            }
          })
          .catch(() => {});
      }
      const s = await getWeeklyLeague(address);
      if (alive) setData(s);
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!data) return null;

  async function collect() {
    if (!me || claiming) return;
    setClaiming(true);
    setClaimError(null);
    try {
      await claimPrizes(me);
      setClaimed(true);
      setPrizeTotal(0n);
    } catch (e) {
      setClaimError((e as Error).message);
    }
    setClaiming(false);
  }

  const bestRank = prizes.reduce((best, p) => (best === 0 ? p.rank : Math.min(best, p.rank)), 0);

  const pool = BigInt(data.poolWei);
  const entered = data.me !== null && data.me.games >= data.minGames;
  const played = data.me?.games ?? 0;

  return (
    <>
      {(prizeTotal > 0n || claimed) && (
        // the win comes FIRST — collecting a prize is the whole reason this
        // player opened the app today
        <div className="card stack animate-in" style={{ gap: 12, padding: 18, boxShadow: "inset 0 0 0 1.5px rgba(246,200,99,0.45)" }}>
          <span className="chip gold" style={{ alignSelf: "flex-start" }}>🏆 Weekly league — you won!</span>
          {claimed ? (
            <span className="chip positive" style={{ alignSelf: "stretch", justifyContent: "center", padding: 10 }}>
              Paid ✓ — it&apos;s in your wallet
            </span>
          ) : (
            <>
              <span className="display" style={{ color: "var(--gold)", fontSize: 32, lineHeight: 0.95, fontVariantNumeric: "tabular-nums" }}>
                {fmt(prizeTotal, STAKE_DECIMALS)} {STAKE_SYMBOL}
              </span>
              <span className="muted">
                You finished {bestRank > 0 ? `#${bestRank}` : "in the money"} last week — your prize is ready.
              </span>
              <button className="btn block" onClick={collect} disabled={claiming}>
                {claiming ? "Collecting…" : "Collect now"}
              </button>
              {claimError && <span className="muted" style={{ color: "var(--danger)", fontSize: 12.5 }}>{claimError}</span>}
            </>
          )}
        </div>
      )}
      <div className="card stack animate-in" style={{ gap: 14, padding: 18 }}>
        <div className="row">
          <span className="chip gold">🏁 Weekly league</span>
          <span className="faint">Ends in {raceEndsIn(data.endsAt)}</span>
        </div>

        {/* the pot is the hero — one big number */}
        {pool > 0n ? (
          <div className="col" style={{ gap: 2 }}>
            <span className="display" style={{ color: "var(--gold)", fontSize: 34, lineHeight: 0.95, fontVariantNumeric: "tabular-nums" }}>
              {fmt(pool, STAKE_DECIMALS)} {STAKE_SYMBOL}
            </span>
            <span className="faint">prize pot · every ranked player gets a share Monday, podium adds a bonus</span>
          </div>
        ) : (
          <span className="muted">The pot grows with every money game this week — every ranked player gets a share Monday, and the podium adds a bonus.</span>
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

        {/* top 3 standings — a tease, not the whole board (the ladder is below) */}
        {data.standings.length > 0 && (
          <div className="card flat stack" style={{ gap: 2, padding: 6 }}>
            {data.standings.slice(0, 3).map((r, i) => {
              const mine = me && r.address.toLowerCase() === me.toLowerCase();
              return (
                <div
                  className="row"
                  key={r.address}
                  style={{ gap: 10, padding: "8px 10px", borderRadius: "var(--r-sm)", background: mine ? "var(--accent-soft)" : "transparent" }}
                >
                  <span style={{ color: MEDAL[i] ?? "var(--faint)", fontWeight: 800, fontVariantNumeric: "tabular-nums", width: 16 }}>
                    {i + 1}
                  </span>
                  <span style={{ flex: 1, fontWeight: 650, fontSize: 13.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {friendlyName(r.address)}
                    {mine && <span style={{ color: "var(--accent)" }}> · you</span>}
                  </span>
                  <span className="faint" style={{ fontVariantNumeric: "tabular-nums" }}>{r.points} pts</span>
                </div>
              );
            })}
          </div>
        )}

        <span className="faint" style={{ fontSize: 11.5 }}>
          Win = 3 pts{SELF_CONFIGURED ? " · prizes require a one-time identity check" : ""}
        </span>
      </div>
    </>
  );
}
