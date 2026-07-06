"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { getInjectedProvider, connect } from "../lib/minipay.js";
import { escrowConfig } from "../lib/escrow.js";
import { getLeaderboard, rankFor, type LeaderRow } from "../lib/profile.js";
import { friendlyName } from "../lib/names.js";

const MEDAL = ["#f6c863", "#cdd3da", "#cd8e5a"]; // gold / silver / bronze

/** Skill ranking (Elo over casual + async play). Kept DELIBERATELY short — the
 *  top few plus your own row, not a wall of near-identical lines. Renders
 *  nothing while empty: the page above owns the "what is a rank" intro. */
export function SkillLeaderboard({ label, top = 5 }: { label?: string; top?: number }) {
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [me, setMe] = useState<Address | null>(null);

  useEffect(() => {
    const p = getInjectedProvider();
    if (p) connect(p, escrowConfig()?.chainId).then(({ address }) => setMe(address)).catch(() => {});
    getLeaderboard(50).then(setRows).catch(() => setRows([]));
  }, []);

  if (rows === null || rows.length === 0) return null;

  const head = rows.slice(0, top);
  const myIndex = me ? rows.findIndex((r) => r.address.toLowerCase() === me.toLowerCase()) : -1;
  const showMe = myIndex >= top; // pinned separately only when outside the head

  const Line = ({ r, i }: { r: LeaderRow; i: number }) => {
    const mine = me != null && r.address.toLowerCase() === me.toLowerCase();
    const rank = rankFor(r.elo);
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
        <span
          style={{
            width: 22,
            textAlign: "center",
            fontWeight: 800,
            fontSize: i < 3 ? 15 : 13.5,
            color: MEDAL[i] ?? "var(--faint)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {i + 1}
        </span>
        <span className="col" style={{ flex: 1, gap: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {friendlyName(r.address)}
            {mine && <span style={{ color: "var(--accent)", fontWeight: 650 }}> · you</span>}
          </span>
          <span className="faint">
            {rank.icon} {rank.name}
          </span>
        </span>
        <span className="score" style={{ fontSize: 17, fontWeight: 750, color: "var(--gold)" }}>
          {r.elo}
        </span>
      </div>
    );
  };

  return (
    <div className="stack" style={{ gap: 6 }}>
      {label && (
        // the unit caption is what tells this list apart from the Weekly race
        // (pts) and the all-time winners (money) — every board names its metric
        <div className="row" style={{ alignItems: "baseline" }}>
          <span className="section-label">{label}</span>
          <span className="faint" style={{ fontSize: 11, letterSpacing: "0.4px", textTransform: "uppercase" }}>
            skill rating · all-time
          </span>
        </div>
      )}
      <div className="card flat" style={{ padding: 6, gap: 0 }}>
        {head.map((r, i) => (
          <Line key={r.address} r={r} i={i} />
        ))}
        {showMe && (
          <>
            <div style={{ textAlign: "center", color: "var(--faint)", fontSize: 12, padding: "2px 0" }}>···</div>
            <Line r={rows[myIndex]} i={myIndex} />
          </>
        )}
      </div>
    </div>
  );
}
