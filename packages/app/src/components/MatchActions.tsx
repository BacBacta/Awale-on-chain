"use client";

import { useState } from "react";
import { readContract } from "viem/actions";
import type { Address } from "viem";
import { publicClient } from "../lib/minipay.js";
import { createMatch, joinMatch, approve, parseStake, type WriteClient, type EscrowConfig } from "../lib/escrow.js";
import { createSessionKey, persistSession } from "../lib/session.js";
import { receiptDeeplink } from "../lib/deeplinks.js";
import { matchEscrowAbi } from "../../../protocol/src/abis.js";

const STAKE_TOKEN = process.env.NEXT_PUBLIC_STAKE_TOKEN as Address | undefined;
const STAKE_DECIMALS = Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "6");
// empty/unset -> omit feeCurrency and let MiniPay handle gas abstraction
const FEE_CURRENCY = (process.env.NEXT_PUBLIC_FEE_CURRENCY || undefined) as Address | undefined;

export function MatchActions({ wallet, account, cfg }: { wallet: WriteClient; account: Address; cfg: EscrowConfig }) {
  const [stake, setStake] = useState("1");
  const [joinId, setJoinId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onCreate() {
    if (!STAKE_TOKEN || busy) return;
    setBusy(true);
    setStatus("Confirming…");
    try {
      const amount = parseStake(stake, STAKE_DECIMALS);
      // the id this create will be assigned (read just before the tx)
      const client = publicClient(cfg.rpcUrl, cfg.chainId);
      const matchId = (await readContract(client, {
        address: cfg.escrow,
        abi: matchEscrowAbi,
        functionName: "nextMatchId",
      })) as bigint;

      const session = createSessionKey();
      persistSession(matchId, session);

      await approve(wallet, { account, token: STAKE_TOKEN, spender: cfg.escrow, amount, feeCurrency: FEE_CURRENCY });
      const hash = await createMatch(wallet, {
        account,
        escrow: cfg.escrow,
        token: STAKE_TOKEN,
        stake: amount,
        session: session.address,
        feeCurrency: FEE_CURRENCY,
      });
      setTx(hash);
      setStatus(`Match #${matchId} created — waiting for an opponent.`);
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onJoin() {
    if (!joinId || busy) return;
    setBusy(true);
    setStatus("Confirming…");
    try {
      const matchId = BigInt(joinId);
      const session = createSessionKey();
      persistSession(matchId, session);
      const hash = await joinMatch(wallet, {
        account,
        escrow: cfg.escrow,
        matchId,
        session: session.address,
        feeCurrency: FEE_CURRENCY,
      });
      setTx(hash);
      setStatus(`Joined match #${matchId}.`);
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="muted">Create a match</span>
        <div className="row">
          <input
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            inputMode="decimal"
            aria-label="Stake"
            style={{ flex: 1, padding: 10, borderRadius: 8, border: "none" }}
          />
          <button className="btn" onClick={onCreate} disabled={busy || !STAKE_TOKEN}>
            Stake &amp; create
          </button>
        </div>
      </div>

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="muted">Join a match</span>
        <div className="row">
          <input
            value={joinId}
            onChange={(e) => setJoinId(e.target.value)}
            inputMode="numeric"
            placeholder="Match #"
            aria-label="Match id"
            style={{ flex: 1, padding: 10, borderRadius: 8, border: "none" }}
          />
          <button className="btn secondary" onClick={onJoin} disabled={busy || !joinId}>
            Join
          </button>
        </div>
      </div>

      {status && <span className="muted">{status}</span>}
      {tx && (
        <a className="muted" href={receiptDeeplink(tx)}>
          View receipt
        </a>
      )}
    </div>
  );
}
