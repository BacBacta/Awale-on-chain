"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { readContract } from "viem/actions";
import type { Address } from "viem";
import { getInjectedProvider, connect, publicClient } from "../../src/lib/minipay.js";
import { escrowConfig } from "../../src/lib/escrow.js";
import { listLocalMatches, statusView } from "../../src/lib/matches.js";
import { computePayout, fmt } from "../../src/lib/money.js";
import { matchEscrowAbi } from "../../../protocol/src/abis.js";

const STAKE_DECIMALS = Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "6");
const STAKE_SYMBOL = process.env.NEXT_PUBLIC_STAKE_SYMBOL ?? "USDC";

interface Row {
  id: bigint;
  status: number;
  stake: bigint;
  rakeBps: number;
}

export default function Matches() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cfg = escrowConfig();
    const ids = listLocalMatches();
    if (!cfg) {
      setError("App not configured for on-chain play.");
      setRows([]);
      return;
    }
    if (ids.length === 0) {
      setRows([]);
      return;
    }
    const client = publicClient(cfg.rpcUrl, cfg.chainId);
    // best-effort wallet connect so reads use the right chain (no prompt if denied)
    const provider = getInjectedProvider();
    if (provider) connect(provider, cfg.chainId).catch(() => {});

    Promise.all(
      ids.map(async (id) => {
        const m = (await readContract(client, {
          address: cfg.escrow,
          abi: matchEscrowAbi,
          functionName: "getMatch",
          args: [id],
        })) as { status: number; stake: bigint; rakeBps: number };
        return { id, status: Number(m.status), stake: m.stake, rakeBps: Number(m.rakeBps) };
      }),
    )
      .then(setRows)
      .catch((e) => {
        setError((e as Error).message);
        setRows([]);
      });
  }, []);

  return (
    <main className="pad stack" style={{ flex: 1, gap: 12 }}>
      <div className="row">
        <span className="title">Your matches</span>
        <Link className="chip" href="/">
          + New
        </Link>
      </div>

      {rows === null ? (
        <div className="card">
          <span className="chip">
            <span className="dot pulse" />
            Loading…
          </span>
        </div>
      ) : rows.length === 0 ? (
        <div className="card stack" style={{ gap: 10, alignItems: "center", textAlign: "center" }}>
          <span style={{ fontSize: 34 }}>🎯</span>
          <span className="h2">No matches yet</span>
          <span className="muted">{error ?? "Create or join a match from the home screen and it will show up here."}</span>
          <Link className="btn block" href="/" style={{ marginTop: 4 }}>
            Go to lobby
          </Link>
        </div>
      ) : (
        rows.map((r) => {
          const sv = statusView(r.status);
          const { prize } = computePayout(r.stake, r.rakeBps);
          return (
            <div className="card row animate-in" key={r.id.toString()}>
              <div className="col" style={{ gap: 6 }}>
                <span className="h2">Match #{r.id.toString()}</span>
                <span className={`chip ${sv.tone}`} style={{ alignSelf: "flex-start" }}>
                  {sv.live && <span className="dot pulse" />}
                  {sv.label}
                </span>
                <span className="faint">
                  Stake {fmt(r.stake, STAKE_DECIMALS)} · pot pays {fmt(prize, STAKE_DECIMALS)} {STAKE_SYMBOL}
                </span>
              </div>
              {sv.live ? (
                <Link className="btn" href={`/play?match=${r.id.toString()}`}>
                  {r.status === 1 ? "Open" : "Resume"}
                </Link>
              ) : (
                <span className="chip">done</span>
              )}
            </div>
          );
        })
      )}
    </main>
  );
}
