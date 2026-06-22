"use client";

import { Icon } from "../../src/components/Icon.js";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { getInjectedProvider, connect } from "../../src/lib/minipay.js";
import { escrowConfig, type WriteClient } from "../../src/lib/escrow.js";
import { fmt } from "../../src/lib/money.js";
import {
  listOpenTournaments,
  joinTournament,
  topPrize,
  tournamentsEnabled,
  type Tournament,
} from "../../src/lib/tournaments.js";

const STAKE_DECIMALS = Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "18");
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
    <main className="pad stack" style={{ flex: 1, gap: 14 }}>
      {/* soft intro */}
      <div className="card row animate-in" style={{ gap: 13, padding: 16 }}>
        <span className="lead gold" style={{ width: 46, height: 46, borderRadius: 15 }}>
          <Icon name="medal" size={23} />
        </span>
        <span className="col" style={{ flex: 1, gap: 3 }}>
          <span className="h2">Tournaments</span>
          <span className="muted" style={{ lineHeight: 1.35 }}>
            One buy-in, a bracket of quick games — the winner takes the pool.
          </span>
        </span>
      </div>

      {!tournamentsEnabled() ? (
        <EmptyState title="Coming soon" sub="Tournaments aren't live in this build yet." />
      ) : list === null ? (
        <div className="card flat row" style={{ justifyContent: "center", padding: 22 }}>
          <span className="chip">
            <span className="dot pulse" /> Loading tables…
          </span>
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title="No open tables right now"
          sub="New Sit-and-Go tables open through the day — check back soon."
          back
        />
      ) : (
        <div className="stack stagger" style={{ gap: 10 }}>
          {list.map((t, i) => {
            const free = BigInt(t.entryFee) === 0n;
            return (
              <div
                className="card stack"
                key={t.id}
                style={{ gap: 13, padding: 14, ["--i" as string]: i }}
              >
                <div className="row" style={{ alignItems: "center" }}>
                  <span className={`lead ${free ? "" : "gold"}`}>
                    <Icon name={free ? "gift" : "trophy"} size={18} />
                  </span>
                  <span className="col" style={{ flex: 1, gap: 2, marginLeft: 12 }}>
                    <span style={{ fontWeight: 700, fontSize: 15 }}>
                      {free ? "Free-roll" : `${fmt(BigInt(t.entryFee), STAKE_DECIMALS)} ${STAKE_SYMBOL}`} ·{" "}
                      {t.maxPlayers}-player SNG
                    </span>
                    <span className="faint">{t.entrants.length}/{t.maxPlayers} seated</span>
                  </span>
                  <span className="chip gold" style={{ alignSelf: "center" }}>
                    win {fmt(topPrize(t), STAKE_DECIMALS)} {STAKE_SYMBOL}
                  </span>
                </div>
                <button
                  className="btn block"
                  onClick={() => join(t)}
                  disabled={!wallet || joining !== null}
                  style={{ padding: "12px 16px" }}
                >
                  {joining === t.id ? "Joining…" : free ? "Enter free-roll" : "Join table"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <span className="chip danger" style={{ alignSelf: "flex-start" }}>
          {error}
        </span>
      )}
    </main>
  );
}

function EmptyState({ title, sub, back }: { title: string; sub: string; back?: boolean }) {
  return (
    <div className="card stack animate-in" style={{ gap: 12, alignItems: "center", textAlign: "center", padding: 28 }}>
      <span className="lead gold" style={{ width: 54, height: 54, borderRadius: 17 }}>
        <Icon name="medal" size={27} />
      </span>
      <span className="h2">{title}</span>
      <span className="muted" style={{ maxWidth: 240, lineHeight: 1.4 }}>{sub}</span>
      {back && (
        <Link className="btn secondary block" href="/" style={{ marginTop: 4 }}>
          Back to lobby
        </Link>
      )}
    </div>
  );
}
