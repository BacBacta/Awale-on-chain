"use client";

import { Icon } from "../../src/components/Icon.js";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { getInjectedProvider, connect } from "../../src/lib/minipay.js";
import { escrowConfig, type WriteClient } from "../../src/lib/escrow.js";
import { fmt } from "../../src/lib/money.js";
import { friendlyName } from "../../src/lib/names.js";
import {
  listOpenTournaments,
  joinTournament,
  topPrize,
  tournamentsEnabled,
  type Tournament,
} from "../../src/lib/tournaments.js";

const STAKE_DECIMALS = Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "6");
const STAKE_SYMBOL = process.env.NEXT_PUBLIC_STAKE_SYMBOL ?? "USDC";
const FEE_CURRENCY = (process.env.NEXT_PUBLIC_FEE_CURRENCY || undefined) as Address | undefined;

export default function Tournaments() {
  const [list, setList] = useState<Tournament[] | null>(null);
  const [wallet, setWallet] = useState<WriteClient | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cfg = escrowConfig();
    (async () => {
      const provider = getInjectedProvider();
      if (provider && cfg) {
        try {
          const c = await connect(provider, cfg.chainId);
          setWallet(c.wallet as unknown as WriteClient);
          setAccount(c.address);
        } catch {
          /* read-only */
        }
      }
      try {
        setList(await listOpenTournaments());
      } catch {
        setList([]);
      }
    })();
  }, []);

  async function join(t: Tournament) {
    const cfg = escrowConfig();
    if (!cfg || !wallet || !account || joining) return;
    setJoining(t.id);
    setError(null);
    try {
      await joinTournament({ wallet, account, t, chainId: cfg.chainId, rpcUrl: cfg.rpcUrl, feeCurrency: FEE_CURRENCY });
      window.location.href = `/play?tournament=${t.id}`;
    } catch (e) {
      setError((e as Error).message);
      setJoining(null);
    }
  }

  return (
    <main className="pad stack" style={{ flex: 1, gap: 12 }}>
      <span className="title">Tournaments</span>
      <span className="muted" style={{ marginTop: -6 }}>
        One buy-in, a bracket of quick games, winner takes the pool.
      </span>

      {!tournamentsEnabled() ? (
        <div className="card stack" style={{ gap: 10, alignItems: "center", textAlign: "center" }}>
          <span className="lead" style={{ width: 52, height: 52, borderRadius: 16 }}>
            <Icon name="trophy" size={26} />
          </span>
          <span className="h2">Coming soon</span>
          <span className="muted">Tournaments aren&apos;t live in this build yet.</span>
        </div>
      ) : list === null ? (
        <div className="card">
          <span className="chip">
            <span className="dot pulse" /> Loading…
          </span>
        </div>
      ) : list.length === 0 ? (
        <div className="card stack" style={{ gap: 10, alignItems: "center", textAlign: "center" }}>
          <span className="lead" style={{ width: 52, height: 52, borderRadius: 16 }}>
            <Icon name="trophy" size={26} />
          </span>
          <span className="h2">No open tournaments</span>
          <span className="muted">Check back soon — new Sit-and-Go tables open through the day.</span>
          <Link className="btn block" href="/" style={{ marginTop: 4 }}>
            Back to lobby
          </Link>
        </div>
      ) : (
        list.map((t) => {
          const free = BigInt(t.entryFee) === 0n;
          const seats = `${t.entrants.length}/${t.maxPlayers}`;
          return (
            <div className="list-row" key={t.id} style={{ cursor: "default" }}>
              <span className={`lead ${free ? "" : "gold"}`}>
                <Icon name={free ? "gift" : "trophy"} size={18} />
              </span>
              <span className="col" style={{ flex: 1, gap: 1 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>
                  {free ? "Free-roll" : `${fmt(BigInt(t.entryFee), STAKE_DECIMALS)} ${STAKE_SYMBOL}`} ·{" "}
                  {t.maxPlayers}-player SNG
                </span>
                <span className="faint">
                  {seats} seated · win up to {fmt(topPrize(t), STAKE_DECIMALS)} {STAKE_SYMBOL}
                </span>
              </span>
              <button
                className="btn"
                style={{ padding: "8px 14px" }}
                onClick={() => join(t)}
                disabled={!wallet || joining !== null}
              >
                {joining === t.id ? "Joining…" : free ? "Enter" : "Join"}
              </button>
            </div>
          );
        })
      )}

      {error && (
        <span className="chip negative" style={{ alignSelf: "flex-start" }}>
          {error}
        </span>
      )}
    </main>
  );
}
