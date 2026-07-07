"use client";

// The winnings-collect surface for the Weekly race. Winners are credited at
// Monday's rollover, but a credit is worthless if they can't find where to
// take it — so this greets them at the TOP of the home lobby the moment they
// open the app, not only inside the Compete tab. Renders nothing when there is
// nothing to collect.
//
// Two payout modes, preferred in this order:
//   1. On-chain (WeeklyPrizes distributor configured): the pot is escrowed in a
//      contract and the winner claims it themselves with a Merkle proof — they
//      can collect even if the server is gone. Costs one small feeCurrency tx.
//   2. Custodial (fallback): the server's operator wallet sends the prize; one
//      tap, no tx. Kept so testnet/no-distributor deployments still pay out.

import { useEffect, useState } from "react";
import { STAKE_DECIMALS, STAKE_SYMBOL } from "../lib/stake.js";
import { waitForTransactionReceipt } from "viem/actions";
import type { Address } from "viem";
import {
  getPendingPrizes,
  claimPrizes,
  getOnchainPrize,
  weeklyPrizesAbi,
  weeklyLeagueEnabled,
  type OnchainPrize,
} from "../lib/weeklyLeague.js";
import { getInjectedProvider, connect, publicClient, effectiveFeeCurrency } from "../lib/minipay.js";
import { escrowConfig } from "../lib/escrow.js";
import { humanizeError } from "../lib/errors.js";
import { fmt } from "../lib/money.js";
import { Icon } from "./Icon.js";

const FEE_CURRENCY = (process.env.NEXT_PUBLIC_FEE_CURRENCY || undefined) as `0x${string}` | undefined;

export function PrizeCollect({ address }: { address: Address | null }) {
  const [total, setTotal] = useState<bigint>(0n);
  const [bestRank, setBestRank] = useState(0);
  const [onchain, setOnchain] = useState<OnchainPrize | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address || !weeklyLeagueEnabled()) return;
    let alive = true;
    (async () => {
      // prefer the on-chain (escrowed) prize; fall back to the custodial one
      const oc = await getOnchainPrize(address);
      if (oc) {
        if (alive) {
          setOnchain(oc);
          setTotal(oc.amountWei);
        }
        return;
      }
      const p = await getPendingPrizes(address);
      if (alive) {
        setTotal(p.totalWei);
        setBestRank(p.prizes.reduce((best, x) => (best === 0 ? x.rank : Math.min(best, x.rank)), 0));
      }
    })().catch(() => {});
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
      if (onchain) {
        // trust-minimised: the winner signs their own claim against the sealed
        // root; the contract verifies and pays from escrow
        const cfg = escrowConfig();
        if (!cfg) throw new Error("network unavailable");
        const provider = getInjectedProvider();
        if (!provider) throw new Error("open in MiniPay to collect");
        const { wallet } = await connect(provider, cfg.chainId);
        const hash = await (wallet as { writeContract: (a: unknown) => Promise<`0x${string}`> }).writeContract({
          address: onchain.distributor,
          abi: weeklyPrizesAbi,
          functionName: "claim",
          args: [onchain.round, onchain.amountWei, onchain.proof],
          account: address,
          feeCurrency: effectiveFeeCurrency(FEE_CURRENCY),
        });
        await waitForTransactionReceipt(publicClient(cfg.rpcUrl, cfg.chainId), { hash });
      } else {
        await claimPrizes(address); // custodial fallback
      }
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
      style={{ gap: 12, padding: 18, boxShadow: "inset 0 0 0 1.5px rgba(76,229,132,0.5)" }}
    >
      <div className="row">
        <span className="chip positive" style={{ alignSelf: "flex-start" }}>
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
            style={{ color: "var(--accent)", fontSize: 34, lineHeight: 0.95, fontVariantNumeric: "tabular-nums" }}
          >
            {fmt(total, STAKE_DECIMALS)} {STAKE_SYMBOL}
          </span>
          <span className="muted">
            {onchain
              ? "Your prize is escrowed on-chain — collect it to your wallet."
              : `You finished ${bestRank > 0 ? `#${bestRank}` : "in the money"} last week — your prize is ready to collect.`}
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
