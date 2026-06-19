"use client";

import { useState } from "react";
import { readContract } from "viem/actions";
import type { Address } from "viem";
import { publicClient } from "../lib/minipay.js";
import { createMatch, joinMatch, approve, parseStake, type WriteClient, type EscrowConfig } from "../lib/escrow.js";
import { createSessionKey, persistSession } from "../lib/session.js";
import { receiptDeeplink } from "../lib/deeplinks.js";
import { matchEscrowAbi, erc20Abi } from "../../../protocol/src/abis.js";

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

  // Approve the escrow to pull `amount` only if the current allowance is short,
  // and WAIT for the approval to be mined before the staking tx — otherwise
  // createMatch/joinMatch estimate gas against a stale (zero) allowance and
  // revert with ERC20InsufficientAllowance.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function ensureAllowance(client: any, token: Address, amount: bigint) {
    const allowance = (await readContract(client, {
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, cfg.escrow],
    })) as bigint;
    if (allowance >= amount) return;
    const hash = await approve(wallet, { account, token, spender: cfg.escrow, amount, feeCurrency: FEE_CURRENCY });
    await client.waitForTransactionReceipt({ hash });
  }

  async function onCreate() {
    if (!STAKE_TOKEN || busy) return;
    setBusy(true);
    setStatus("Confirming…");
    try {
      const amount = parseStake(stake, STAKE_DECIMALS);
      const client = publicClient(cfg.rpcUrl, cfg.chainId);
      const matchId = (await readContract(client, {
        address: cfg.escrow,
        abi: matchEscrowAbi,
        functionName: "nextMatchId",
      })) as bigint;

      const session = createSessionKey();
      persistSession(matchId, session);

      await ensureAllowance(client, STAKE_TOKEN, amount);
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
      const client = publicClient(cfg.rpcUrl, cfg.chainId);
      // joining also stakes, so read the match's token + stake and approve first
      const m = (await readContract(client, {
        address: cfg.escrow,
        abi: matchEscrowAbi,
        functionName: "getMatch",
        args: [matchId],
      })) as { token: Address; stake: bigint };

      const session = createSessionKey();
      persistSession(matchId, session);

      await ensureAllowance(client, m.token, m.stake);
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
