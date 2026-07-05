"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { getInjectedProvider, connect } from "../lib/minipay.js";
import { escrowConfig } from "../lib/escrow.js";
import { loadLeaderboard, type LeaderRow } from "../lib/leaderboard.js";
import { friendlyName } from "../lib/names.js";
import { shortAddress } from "../lib/identity.js";
import { fmt } from "../lib/money.js";

const STAKE_DECIMALS = Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "18");
const STAKE_SYMBOL = process.env.NEXT_PUBLIC_STAKE_SYMBOL ?? "USDC";
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
            <span className="col" style={{ flex: 1, gap: 1 }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>
                {friendlyName(r.address)} {mine && <span className="faint">(you)</span>}
              </span>
              {/* the wallet suffix anchors the pseudonym to a REAL account —
                  a column of bare generated handles read as placeholder data */}
              <span className="faint" style={{ fontVariantNumeric: "tabular-nums" }}>
                {r.wins} {r.wins === 1 ? "win" : "wins"} · {shortAddress(r.address)}
              </span>
            </span>
            <span className="score" style={{ fontWeight: 750, color: "var(--accent)" }}>
              {fmt(r.net, STAKE_DECIMALS)} {STAKE_SYMBOL}
            </span>
          </div>
        );
      })}
    </div>
  );
}
