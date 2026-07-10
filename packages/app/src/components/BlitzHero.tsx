"use client";

// The Weekend Blitz hero — the premium face of a funded special race. One
// component, two variants: "banner" (home lobby, taps through to the race) and
// "full" (the Blitz tab header on /compete, with the CTA). Gold frames the
// EVENT (rotating conic ring, sparks, sweep); the pot itself glows money-green
// per the color system. Renders nothing unless a blitz is live, and vanishes
// by itself at Monday's rollover.

import { useEffect, useState } from "react";
import Link from "next/link";
import { STAKE_DECIMALS, STAKE_SYMBOL } from "../lib/stake.js";
import {
  getWeeklyLeague,
  weeklyLeagueEnabled,
  isBlitzActive,
  BLITZ_LABEL,
  type WeeklyLeagueSnapshot,
} from "../lib/weeklyLeague.js";
import { fmt } from "../lib/money.js";
import { Icon } from "./Icon.js";

/** d/h/m/s until the race closes — drives the live casino-board countdown. */
function parts(endsAt: number, now: number) {
  const ms = Math.max(0, endsAt - now);
  const s = Math.floor(ms / 1000);
  return {
    d: Math.floor(s / 86_400),
    h: Math.floor((s % 86_400) / 3600),
    m: Math.floor((s % 3600) / 60),
    s: s % 60,
  };
}

function Countdown({ endsAt }: { endsAt: number }) {
  // tick every second — the moving clock is what makes the event feel LIVE
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const p = parts(endsAt, now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <span className="blitz-timer" aria-label="time left in the blitz">
      {p.d > 0 && (
        <span className="unit">
          {p.d}
          <small>d</small>
        </span>
      )}
      <span className="unit">
        {pad(p.h)}
        <small>h</small>
      </span>
      <span className="unit">
        {pad(p.m)}
        <small>m</small>
      </span>
      <span className="unit">
        {pad(p.s)}
        <small>s</small>
      </span>
    </span>
  );
}

function Sparks() {
  return (
    <>
      <span aria-hidden className="blitz-spark" style={{ top: "22%", right: "14%" }} />
      <span aria-hidden className="blitz-spark" style={{ top: "58%", right: "30%", animationDelay: "1.6s" }} />
      <span aria-hidden className="blitz-spark" style={{ top: "34%", left: "42%", animationDelay: "3.1s", width: 3, height: 3 }} />
    </>
  );
}

export function BlitzHero({ variant }: { variant: "banner" | "full" }) {
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

  const head = (
    <div className="row" style={{ alignItems: "center", gap: 8, position: "relative", flexWrap: "wrap", rowGap: 8 }}>
      <span
        className="chip gold"
        style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", whiteSpace: "nowrap" }}
      >
        ⚡ {BLITZ_LABEL}
      </span>
      <span
        className="chip"
        style={{ gap: 5, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap" }}
      >
        <span className="dot pulse" style={{ background: "var(--accent)" }} />
        Live
      </span>
      <span style={{ flex: 1 }} />
      <Countdown endsAt={data.endsAt} />
    </div>
  );

  const pot = (
    <div className="col" style={{ gap: 3, position: "relative" }}>
      <span className="faint" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1.1, textTransform: "uppercase" }}>
        Prize pool
      </span>
      <span className="display blitz-pot" style={{ fontSize: variant === "full" ? 44 : 38, lineHeight: 0.95 }}>
        {fmt(pool, STAKE_DECIMALS)} <span style={{ fontSize: variant === "full" ? 20 : 17 }}>{STAKE_SYMBOL}</span>
      </span>
    </div>
  );

  if (variant === "banner") {
    return (
      <Link href="/compete#blitz" className="blitz-frame animate-in" style={{ textDecoration: "none", display: "block" }}>
        <div className="blitz-card">
          <Sparks />
          {head}
          <div className="row" style={{ alignItems: "flex-end", gap: 10, position: "relative" }}>
            {pot}
            <span style={{ flex: 1 }} />
            <span
              className="row"
              style={{ gap: 5, color: "var(--gold)", fontWeight: 750, fontSize: 12.5, whiteSpace: "nowrap", paddingBottom: 4 }}
            >
              See the race <Icon name="arrowRight" size={15} />
            </span>
          </div>
          <span className="faint" style={{ fontSize: 12, position: "relative" }}>
            This weekend only — every staked match counts. Play, score points, share the pot.
          </span>
        </div>
      </Link>
    );
  }

  return (
    <div id="blitz" className="blitz-frame animate-in">
      <div className="blitz-card">
        <Sparks />
        {head}
        {pot}
        <span className="muted" style={{ fontSize: 12.5, position: "relative" }}>
          A specially funded race, this weekend only. Every staked match earns points — win 3 pts, the pot splits by
          points when the clock hits zero, top ranks take a bonus.
        </span>
        <div className="row" style={{ gap: 8, position: "relative" }}>
          <Link className="btn shine" href="/?money=1" style={{ flex: 1, justifyContent: "center" }}>
            <Icon name="bolt" size={16} /> Enter the Blitz
          </Link>
        </div>
        <span className="faint" style={{ fontSize: 11, position: "relative" }}>
          {data.minGames} money games to rank · counted automatically · paid out Monday
        </span>
      </div>
    </div>
  );
}
