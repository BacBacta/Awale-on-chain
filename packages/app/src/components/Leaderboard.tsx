"use client";

import { useEffect, useState } from "react";
import { STAKE_DECIMALS, STAKE_SYMBOL } from "../lib/stake.js";
import type { Address } from "viem";
import { getInjectedProvider, connect } from "../lib/minipay.js";
import { escrowConfig } from "../lib/escrow.js";
import { loadLeaderboard, type LeaderRow } from "../lib/leaderboard.js";
import { friendlyName, nameHue, nameInitials } from "../lib/names.js";
import { fmt } from "../lib/money.js";

const MEDAL = ["#f6c863", "#cdd3da", "#cd8e5a"]; // gold / silver / bronze

export function Leaderboard() {
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [me, setMe] = useState<Address | null>(null);

  useEffect(() => {
    const cfg = escrowConfig();
    if (!cfg) {
      setRows([]);
      return;
    }
    const p = getInjectedProvider();
    if (p) connect(p, cfg.chainId).then(({ address }) => setMe(address)).catch(() => {});
    loadLeaderboard(cfg).then(setRows).catch(() => setRows([]));
  }, []);

  if (rows === null) {
    return (
      <div className="card">
        <span className="chip">
          <span className="dot pulse" /> Loading leaderboard…
        </span>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="card stack" style={{ gap: 10, alignItems: "center", textAlign: "center" }}>
        <span className="muted">No settled money matches yet — win one to claim the top spot.</span>
        <a className="btn secondary block" href="/?money=1">
          Play for money
        </a>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.map((r, i) => {
        const mine = me && r.address.toLowerCase() === me.toLowerCase();
        return (
          <div
            className="list-row"
            key={r.address}
            style={mine ? { boxShadow: "inset 0 0 0 1.5px rgba(76,229,132,0.5)" } : undefined}
          >
            <span
              className="lead neutral"
              style={{ color: i < 3 ? MEDAL[i] : "var(--faint)", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}
            >
              {i + 1}
            </span>
            {/* per-player avatar (deterministic colour + initials): rows of
                bare generated handles read as placeholder data, and showing an
                address would be crypto-speak — a visual identity does the
                anchoring in everyone's language */}
            <span
              aria-hidden
              style={{
                width: 30,
                height: 30,
                borderRadius: 10,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 800,
                color: "rgba(255,255,255,0.92)",
                background: `linear-gradient(135deg, hsl(${nameHue(r.address)} 45% 38%), hsl(${(nameHue(r.address) + 40) % 360} 50% 26%))`,
              }}
            >
              {nameInitials(r.address)}
            </span>
            <span className="col" style={{ flex: 1, gap: 1 }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>
                {friendlyName(r.address)} {mine && <span className="faint">(you)</span>}
              </span>
              <span className="faint">
                {r.wins} {r.wins === 1 ? "win" : "wins"}
              </span>
            </span>
            {/* TRUE net (prizes − stakes), signed — the same metric and colour
                code as the personal "Net winnings" card, so the two can never
                contradict each other again */}
            <span className="score" style={{ fontWeight: 750, color: r.net >= 0n ? "var(--accent)" : "var(--danger)" }}>
              {r.net >= 0n ? "+" : "−"}
              {fmt(r.net < 0n ? -r.net : r.net, STAKE_DECIMALS)} {STAKE_SYMBOL}
            </span>
          </div>
        );
      })}
    </div>
  );
}
