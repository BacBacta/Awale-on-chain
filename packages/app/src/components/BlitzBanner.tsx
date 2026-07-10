"use client";

// Premium home-lobby banner for a funded special race (the "Weekend Blitz").
// Renders only while a blitz is live (pool seeded above the normal-week rake),
// and auto-disappears at Monday's rollover. Gold framing = "premium / special
// event"; the pot number stays money-green (--accent) so it never reads as the
// skill boards. Tapping it lands on the Blitz tab of /compete.

import { useEffect, useState } from "react";
import Link from "next/link";
import { STAKE_DECIMALS, STAKE_SYMBOL } from "../lib/stake.js";
import {
  getWeeklyLeague,
  raceEndsIn,
  weeklyLeagueEnabled,
  isBlitzActive,
  BLITZ_LABEL,
  type WeeklyLeagueSnapshot,
} from "../lib/weeklyLeague.js";
import { fmt } from "../lib/money.js";
import { Icon } from "./Icon.js";

export function BlitzBanner() {
  const [data, setData] = useState<WeeklyLeagueSnapshot | null>(null);

  useEffect(() => {
    if (!weeklyLeagueEnabled()) return;
    let alive = true;
    getWeeklyLeague()
      .then((s) => {
        if (alive) setData(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!data || !isBlitzActive(data.poolWei, STAKE_DECIMALS)) return null;
  const pool = BigInt(data.poolWei);

  return (
    <Link
      href="/compete#blitz"
      className="card animate-in"
      style={{
        position: "relative",
        overflow: "hidden",
        textDecoration: "none",
        padding: "16px 16px",
        border: "1px solid var(--gold)",
        background:
          "linear-gradient(135deg, rgba(246,200,99,0.16), rgba(246,200,99,0.05) 42%, rgba(20,18,14,0.2))",
        boxShadow: "0 6px 26px -10px rgba(246,200,99,0.45)",
      }}
    >
      <div className="row" style={{ alignItems: "center", gap: 12 }}>
        <div className="col" style={{ flex: 1, gap: 6, minWidth: 0 }}>
          <span className="row" style={{ gap: 6 }}>
            <span
              className="chip gold"
              style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase" }}
            >
              ⚡ {BLITZ_LABEL}
            </span>
            <span className="faint" style={{ fontSize: 11.5 }}>
              Ends in {raceEndsIn(data.endsAt)}
            </span>
          </span>
          <span
            className="display"
            style={{ color: "var(--accent)", fontSize: 30, lineHeight: 0.95, fontVariantNumeric: "tabular-nums" }}
          >
            {fmt(pool, STAKE_DECIMALS)} {STAKE_SYMBOL}
          </span>
          <span className="faint" style={{ fontSize: 12.5 }}>
            Prize pool · play staked matches, share the pot →
          </span>
        </div>
        <Icon name="arrowRight" size={18} style={{ color: "var(--gold)" }} />
      </div>
    </Link>
  );
}
