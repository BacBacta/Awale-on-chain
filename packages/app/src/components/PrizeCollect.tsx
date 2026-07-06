"use client";

// The winnings-collect surface for the Weekly race. Winners are credited at
// Monday's rollover, but a credit is worthless if they can't find where to
// take it — so this greets them at the TOP of the home lobby the moment they
// open the app, not only inside the Compete tab. Renders nothing when there is
// nothing to collect, so it never adds noise for a player who hasn't won.

import { useEffect, useState } from "react";
import { STAKE_DECIMALS, STAKE_SYMBOL } from "../lib/stake.js";
import type { Address } from "viem";
import { getPendingPrizes, claimPrizes, weeklyLeagueEnabled } from "../lib/weeklyLeague.js";
import { humanizeError } from "../lib/errors.js";
import { fmt } from "../lib/money.js";
import { Icon } from "./Icon.js";

export function PrizeCollect({ address }: { address: Address | null }) {
  const [total, setTotal] = useState<bigint>(0n);
  const [bestRank, setBestRank] = useState(0);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address || !weeklyLeagueEnabled()) return;
    let alive = true;
    getPendingPrizes(address)
      .then((p) => {
        if (!alive) return;
        setTotal(p.totalWei);
        setBestRank(p.prizes.reduce((best, x) => (best === 0 ? x.rank : Math.min(best, x.rank)), 0));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [address]);

  if (!address || (total === 0n && !claimed)) return null;

  async function collect() {
    if (!address || claiming) return;
    setClaiming(true);
    setError(null);
    try {
      await claimPrizes(address);
      setClaimed(true);
      setTotal(0n);
    } catch (e) {
      setError(humanizeError(e));
    }
    setClaiming(false);
  }

  return (
    <div
      className="card stack animate-in"
      style={{ gap: 12, padding: 18, boxShadow: "inset 0 0 0 1.5px rgba(246,200,99,0.5)" }}
    >
      <div className="row">
        <span className="chip gold" style={{ alignSelf: "flex-start" }}>
          <Icon name="trophy" size={14} /> Weekly race — you won!
        </span>
      </div>
      {claimed ? (
        <span className="chip positive" style={{ alignSelf: "stretch", justifyContent: "center", padding: 10 }}>
          Paid ✓ — it&apos;s in your wallet
        </span>
      ) : (
        <>
          <span
            className="display"
            style={{ color: "var(--gold)", fontSize: 34, lineHeight: 0.95, fontVariantNumeric: "tabular-nums" }}
          >
            {fmt(total, STAKE_DECIMALS)} {STAKE_SYMBOL}
          </span>
          <span className="muted">
            You finished {bestRank > 0 ? `#${bestRank}` : "in the money"} last week — your prize is ready to collect.
          </span>
          <button className="btn block" onClick={collect} disabled={claiming}>
            {claiming ? "Collecting…" : "Collect now"}
          </button>
          {error && <span className="muted" style={{ color: "var(--danger)", fontSize: 12.5 }}>{error}</span>}
        </>
      )}
    </div>
  );
}
