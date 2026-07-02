"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { getInjectedProvider, connect } from "../lib/minipay.js";
import { escrowConfig } from "../lib/escrow.js";
import { getLeaderboard, rankFor, type LeaderRow } from "../lib/profile.js";
import { friendlyName } from "../lib/names.js";

const MEDAL = ["#f6c863", "#cdd3da", "#cd8e5a"]; // gold / silver / bronze

/** Skill ranking (Elo over casual + async play) — the money leaderboard's
 *  sibling, fed by the server-side player profile instead of chain events.
 *  Renders nothing while empty: the page above it owns the "what is a rank"
 *  introduction, so an empty ladder never stacks a second empty state. */
export function SkillLeaderboard({ label }: { label?: string }) {
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [me, setMe] = useState<Address | null>(null);

  useEffect(() => {
    const p = getInjectedProvider();
    if (p) connect(p, escrowConfig()?.chainId).then(({ address }) => setMe(address)).catch(() => {});
    getLeaderboard(10).then(setRows).catch(() => setRows([]));
  }, []);

  if (rows === null || rows.length === 0) return null;

  return (
    <div className="stack" style={{ gap: 8 }}>
      {label && <span className="section-label">{label}</span>}
      {rows.map((r, i) => {
        const mine = me && r.address.toLowerCase() === me.toLowerCase();
        const rank = rankFor(r.elo);
        return (
          <div
            className="list-row"
            key={r.address}
            style={mine ? { boxShadow: "inset 0 0 0 1.5px var(--accent)" } : undefined}
          >
            <span
              className="lead neutral"
              style={{ width: 34, height: 34, fontWeight: 800, color: MEDAL[i] ?? "var(--faint)" }}
            >
              {i + 1}
            </span>
            <span className="col" style={{ flex: 1, gap: 1 }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>
                {friendlyName(r.address)}
                {mine ? " · you" : ""}
              </span>
              <span className="faint">
                {rank.icon} {rank.name} · {r.gamesWon}W / {r.gamesPlayed}G
              </span>
            </span>
            <span className="title score" style={{ fontSize: 18, color: "var(--gold)" }}>
              {r.elo}
            </span>
          </div>
        );
      })}
    </div>
  );
}
