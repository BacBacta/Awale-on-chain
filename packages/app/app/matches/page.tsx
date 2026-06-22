"use client";

import { Icon } from "../../src/components/Icon.js";
import { useEffect, useState } from "react";
import Link from "next/link";
import { readContract } from "viem/actions";
import type { Address } from "viem";
import { getInjectedProvider, connect, publicClient } from "../../src/lib/minipay.js";
import { escrowConfig } from "../../src/lib/escrow.js";
import { listLocalMatches, statusView } from "../../src/lib/matches.js";
import { computePayout, fmt } from "../../src/lib/money.js";
import { matchEscrowAbi } from "../../../protocol/src/abis.js";
import { createSessionKey, persistSession } from "../../src/lib/session.js";
import { asyncEnabled, createAsync, recordAsyncMatch, listAsyncMatchIds, getAsync, roleOf } from "../../src/lib/asyncClient.js";
import { loadSession } from "../../src/lib/session.js";
import { displayName } from "../../src/lib/names.js";

const STAKE_DECIMALS = Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "6");
const STAKE_SYMBOL = process.env.NEXT_PUBLIC_STAKE_SYMBOL ?? "USDC";

interface Row {
  id: bigint;
  status: number;
  stake: bigint;
  rakeBps: number;
}

interface AsyncRow {
  id: string;
  opponent: string;
  yourTurn: boolean;
  open: boolean;
  over: boolean;
}

export default function Matches() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asyncRows, setAsyncRows] = useState<AsyncRow[]>([]);

  useEffect(() => {
    const ids = listAsyncMatchIds();
    if (ids.length === 0) return;
    Promise.all(
      ids.map(async (id) => {
        try {
          const s = await getAsync(id);
          const sk = loadSession(BigInt(id));
          const role = sk ? roleOf(s, sk.address) : null;
          return {
            id,
            opponent: s.open ? "Waiting for opponent" : displayName(role === 0 ? s.players[1] : s.players[0]),
            yourTurn: !s.over && !s.open && role !== null && s.turn === role,
            open: s.open,
            over: s.over,
          } as AsyncRow;
        } catch {
          return null;
        }
      }),
    ).then((r) => setAsyncRows(r.filter((x): x is AsyncRow => x !== null)));
  }, []);

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

  const [creating, setCreating] = useState(false);
  async function newCorrespondence() {
    if (creating) return;
    setCreating(true);
    try {
      const session = createSessionKey();
      const id = await createAsync(session.address);
      persistSession(BigInt(id), session);
      recordAsyncMatch(id);
      window.location.href = `/play?async=${id}`;
    } catch {
      setCreating(false);
    }
  }

  return (
    <main className="pad stack" style={{ flex: 1, gap: 12 }}>
      <span className="title">Your matches</span>

      {asyncEnabled() && (
        <button className="btn block" onClick={newCorrespondence} disabled={creating}>
          <Icon name="versus" size={17} /> {creating ? "Creating…" : "New correspondence game"}
        </button>
      )}

      {asyncRows.length > 0 && (
        <>
          <span className="section-label">
            Correspondence
            {asyncRows.some((r) => r.yourTurn) && (
              <span className="chip positive" style={{ marginLeft: 8 }}>
                {asyncRows.filter((r) => r.yourTurn).length} need your move
              </span>
            )}
          </span>
          {asyncRows.map((r) => (
            <Link className="list-row" key={r.id} href={`/play?async=${r.id}`}>
              <span className={`lead ${r.yourTurn ? "" : "neutral"}`}>
                <Icon name="versus" size={18} />
              </span>
              <span className="col" style={{ flex: 1, gap: 2 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{r.opponent}</span>
                <span className="faint">
                  {r.over ? "Finished" : r.open ? "Invite pending" : r.yourTurn ? "Your turn" : "Their turn"}
                </span>
              </span>
              {r.yourTurn && (
                <span className="chip positive" style={{ marginRight: 4 }}>
                  <span className="dot pulse" /> Play
                </span>
              )}
            </Link>
          ))}
        </>
      )}

      {rows === null ? (
        <div className="card">
          <span className="chip">
            <span className="dot pulse" />
            Loading…
          </span>
        </div>
      ) : rows.length === 0 ? (
        <div className="card stack" style={{ gap: 10, alignItems: "center", textAlign: "center" }}>
          <span className="lead" style={{ width: 52, height: 52, borderRadius: 16 }}>
            <Icon name="target" size={26} />
          </span>
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
