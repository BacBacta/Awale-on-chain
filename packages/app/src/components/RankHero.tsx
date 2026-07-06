"use client";

// The signature "who am I" card, shared by Profile and Compete so the identity
// reads identically in both. One focal number (the rating, in the display
// serif), the tier it earns, and a slim bar showing the climb to the next tier
// — premium without clutter. Optionally leads with the avatar + address
// (Profile); Compete uses the rank-only form.

import type { Address } from "viem";
import { shortAddress } from "../lib/identity.js";
import { tierProgress } from "../lib/profile.js";

export function avatarGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 62% 52%), hsl(${(h + 40) % 360} 60% 38%))`;
}

export function RankHero({
  elo,
  wins,
  games,
  perfectDays = 0,
  name,
  address,
}: {
  elo: number;
  wins: number;
  games: number;
  perfectDays?: number;
  /** when set, the card leads with an avatar + address row (Profile) */
  name?: string;
  address?: Address | null;
}) {
  const { cur, next, pct, toNext } = tierProgress(elo);
  const initial = name?.trim()[0]?.toUpperCase() ?? "?";

  return (
    <div className="card animate-in" style={{ padding: 0, overflow: "hidden", gap: 0 }}>
      {name && (
        <div className="row" style={{ gap: 14, alignItems: "center", padding: "16px 18px 12px" }}>
          <div
            aria-hidden
            style={{
              width: 54,
              height: 54,
              borderRadius: "50%",
              background: avatarGradient(name),
              display: "grid",
              placeItems: "center",
              fontWeight: 800,
              fontSize: 23,
              color: "#0b0f0a",
              boxShadow: "0 0 0 2px var(--accent), 0 8px 22px rgba(76,229,132,0.18)",
            }}
          >
            {initial}
          </div>
          <div className="col" style={{ flex: 1, gap: 2, minWidth: 0 }}>
            <span style={{ fontWeight: 750, fontSize: 18, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {name}
            </span>
            <span className="faint">{address ? shortAddress(address) : "Open in MiniPay"}</span>
          </div>
        </div>
      )}

      <div
        className="row"
        style={{
          alignItems: "flex-end",
          padding: name ? "0 18px 4px" : "18px 18px 4px",
        }}
      >
        <div className="col" style={{ gap: 8 }}>
          <span className="chip gold" style={{ alignSelf: "flex-start" }}>
            {cur.icon} {cur.name}
          </span>
          {/* "every match" is the scope: free AND money games rate here, so
              this count is deliberately bigger than the money-only record */}
          <span className="faint">
            {wins} wins · {games} games · every match
            {perfectDays > 0 ? ` · ✨ ${perfectDays}` : ""}
          </span>
        </div>
        <div className="col" style={{ alignItems: "flex-end", gap: 0 }}>
          <span className="display" style={{ color: "var(--gold)", fontSize: 42, lineHeight: 0.95, fontVariantNumeric: "tabular-nums" }}>
            {elo}
          </span>
          <span className="faint" style={{ fontSize: 10, letterSpacing: "0.7px", textTransform: "uppercase" }}>
            rating
          </span>
        </div>
      </div>

      {/* the climb — a quiet bar so the rank feels like progress, not a dead number */}
      <div className="col" style={{ gap: 6, padding: "12px 18px 16px" }}>
        <div style={{ height: 6, borderRadius: 999, background: "rgba(255,255,255,0.06)", overflow: "hidden", boxShadow: "inset 0 0 0 1px var(--line)" }}>
          <div
            style={{
              width: `${pct * 100}%`,
              height: "100%",
              borderRadius: 999,
              background: "linear-gradient(90deg, var(--gold-soft), var(--gold))",
              transition: "width 600ms var(--ease-out)",
            }}
          />
        </div>
        <span className="faint" style={{ fontSize: 11.5 }}>
          {next ? `${toNext} to ${next.icon} ${next.name}` : "Top tier — you're a 👑 Grandmaster"}
        </span>
      </div>
    </div>
  );
}
