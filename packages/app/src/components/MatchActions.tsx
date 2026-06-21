"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { readContract } from "viem/actions";
import type { Address } from "viem";
import { publicClient } from "../lib/minipay.js";
import { createMatch, joinMatch, approve, parseStake, type WriteClient, type EscrowConfig } from "../lib/escrow.js";
import { createSessionKey, persistSession } from "../lib/session.js";
import { receiptDeeplink } from "../lib/deeplinks.js";
import { computePayout, fmt, rakePct } from "../lib/money.js";
import { humanizeError } from "../lib/errors.js";
import { recordLocalMatch } from "../lib/matches.js";
import { matchEscrowAbi, erc20Abi } from "../../../protocol/src/abis.js";

const STAKE_TOKEN = process.env.NEXT_PUBLIC_STAKE_TOKEN as Address | undefined;
const STAKE_DECIMALS = Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "6");
const STAKE_SYMBOL = process.env.NEXT_PUBLIC_STAKE_SYMBOL ?? "USDC";
// empty/unset -> omit feeCurrency and let MiniPay handle gas abstraction
const FEE_CURRENCY = (process.env.NEXT_PUBLIC_FEE_CURRENCY || undefined) as Address | undefined;

const QUICK_STAKES = ["1", "5", "10"];

type Step = "idle" | "approving" | "staking" | "done" | "error";

export function MatchActions({ wallet, account, cfg }: { wallet: WriteClient; account: Address; cfg: EscrowConfig }) {
  const [stake, setStake] = useState("1");
  const [joinId, setJoinId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [openId, setOpenId] = useState<bigint | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [rakeBps, setRakeBps] = useState<number>(0);
  const [copied, setCopied] = useState(false);

  const busy = step === "approving" || step === "staking";

  // Read the player's balance and the live rake once, for the payout preview.
  useEffect(() => {
    if (!STAKE_TOKEN) return;
    const client = publicClient(cfg.rpcUrl, cfg.chainId);
    Promise.all([
      readContract(client, { address: STAKE_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      readContract(client, { address: cfg.escrow, abi: matchEscrowAbi, functionName: "rakeBps" }),
    ])
      .then(([bal, rake]) => {
        setBalance(bal as bigint);
        setRakeBps(Number(rake));
      })
      .catch(() => {
        /* preview is best-effort */
      });
  }, [account, cfg]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function ensureAllowance(client: any, token: Address, amount: bigint) {
    const allowance = (await readContract(client, {
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, cfg.escrow],
    })) as bigint;
    if (allowance >= amount) return;
    setStep("approving");
    const hash = await approve(wallet, { account, token, spender: cfg.escrow, amount, feeCurrency: FEE_CURRENCY });
    await client.waitForTransactionReceipt({ hash });
  }

  function fail(e: unknown) {
    setError(humanizeError(e));
    setStep("error");
  }

  async function onCreate() {
    if (!STAKE_TOKEN || busy) return;
    setError(null);
    try {
      const amount = parseStake(stake, STAKE_DECIMALS);
      if (amount <= 0n) return setError("Enter a stake greater than zero.");
      if (balance !== null && amount > balance) return setError(`Not enough ${STAKE_SYMBOL} for this stake.`);
      const client = publicClient(cfg.rpcUrl, cfg.chainId);
      const matchId = (await readContract(client, {
        address: cfg.escrow,
        abi: matchEscrowAbi,
        functionName: "nextMatchId",
      })) as bigint;

      const session = createSessionKey();
      persistSession(matchId, session);
      recordLocalMatch(matchId);

      await ensureAllowance(client, STAKE_TOKEN, amount);
      setStep("staking");
      const hash = await createMatch(wallet, {
        account,
        escrow: cfg.escrow,
        token: STAKE_TOKEN,
        stake: amount,
        session: session.address,
        feeCurrency: FEE_CURRENCY,
      });
      setTx(hash);
      setOpenId(matchId);
      setStep("done");
    } catch (e) {
      fail(e);
    }
  }

  async function onJoin() {
    if (!joinId || busy) return;
    setError(null);
    try {
      const matchId = BigInt(joinId);
      const client = publicClient(cfg.rpcUrl, cfg.chainId);
      const m = (await readContract(client, {
        address: cfg.escrow,
        abi: matchEscrowAbi,
        functionName: "getMatch",
        args: [matchId],
      })) as { token: Address; stake: bigint };

      const session = createSessionKey();
      persistSession(matchId, session);
      recordLocalMatch(matchId);

      await ensureAllowance(client, m.token, m.stake);
      setStep("staking");
      const hash = await joinMatch(wallet, {
        account,
        escrow: cfg.escrow,
        matchId,
        session: session.address,
        feeCurrency: FEE_CURRENCY,
      });
      setTx(hash);
      setOpenId(matchId);
      setStep("done");
    } catch (e) {
      fail(e);
    }
  }

  function shareInvite() {
    if (openId === null) return;
    const url = `${window.location.origin}/play?match=${openId.toString()}`;
    const data = { title: "Awalé", text: `Join my Awalé match #${openId} for ${stake} ${STAKE_SYMBOL}`, url };
    if (navigator.share) navigator.share(data).catch(() => {});
    else
      navigator.clipboard?.writeText(url).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
  }

  // payout preview
  const stakeRaw = (() => {
    try {
      return parseStake(stake || "0", STAKE_DECIMALS);
    } catch {
      return 0n;
    }
  })();
  const { pot, rake, prize } = computePayout(stakeRaw, rakeBps);

  // --- waiting room after a successful create/join ---
  if (step === "done" && openId !== null) {
    return (
      <div className="stack animate-in">
        <div className="card stack" style={{ gap: 12, alignItems: "center", textAlign: "center" }}>
          <span className="chip positive">
            <span className="dot pulse" />
            Waiting for an opponent
          </span>
          <span className="display">Match #{openId.toString()}</span>
          <span className="muted">
            Pot {fmt(pot, STAKE_DECIMALS)} {STAKE_SYMBOL} · winner takes {fmt(prize, STAKE_DECIMALS)}
          </span>
        </div>
        <button className="btn block" onClick={shareInvite}>
          {copied ? "Link copied ✓" : "Invite an opponent"}
        </button>
        <Link className="btn secondary block" href={`/play?match=${openId.toString()}`}>
          Open match →
        </Link>
        {tx && (
          <a className="btn ghost block" href={receiptDeeplink(tx)}>
            View receipt
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="stack">
      {/* Create */}
      <div className="card stack" style={{ gap: 12 }}>
        <div className="row">
          <span className="h2">Create a match</span>
          {balance !== null && (
            <span className="faint">
              Balance {fmt(balance, STAKE_DECIMALS)} {STAKE_SYMBOL}
            </span>
          )}
        </div>

        <div className="row" style={{ gap: 8 }}>
          <div className="row input" style={{ gap: 6 }}>
            <input
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              inputMode="decimal"
              aria-label="Stake"
              style={{ background: "transparent", border: "none", color: "var(--text)", width: "100%", outline: "none" }}
            />
            <span className="muted" style={{ fontWeight: 700 }}>
              {STAKE_SYMBOL}
            </span>
          </div>
        </div>

        <div className="row" style={{ gap: 6 }}>
          {QUICK_STAKES.map((q) => (
            <button
              key={q}
              className={`chip ${stake === q ? "positive" : ""}`}
              onClick={() => setStake(q)}
              style={{ cursor: "pointer", flex: 1, justifyContent: "center", padding: "8px 0" }}
            >
              {q}
            </button>
          ))}
        </div>

        {/* payout preview — mirrors MatchEscrow._payout */}
        <div className="card flat row" style={{ padding: "10px 12px" }}>
          <span className="muted">
            Pot <b style={{ color: "var(--text)" }}>{fmt(pot, STAKE_DECIMALS)}</b>
          </span>
          <span className="muted">
            You win{" "}
            <b style={{ color: "var(--accent)" }}>
              {fmt(prize, STAKE_DECIMALS)} {STAKE_SYMBOL}
            </b>
          </span>
          <span className="faint">
            fee {fmt(rake, STAKE_DECIMALS)} ({rakePct(rakeBps)})
          </span>
        </div>

        <button className="btn block" onClick={onCreate} disabled={busy || !STAKE_TOKEN}>
          {step === "approving" ? "Approving…" : step === "staking" ? "Staking…" : `Stake ${stake || "0"} ${STAKE_SYMBOL} & create`}
        </button>
      </div>

      {/* Join */}
      <div className="card stack" style={{ gap: 10 }}>
        <span className="h2">Join a match</span>
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input"
            value={joinId}
            onChange={(e) => setJoinId(e.target.value)}
            inputMode="numeric"
            placeholder="Match #"
            aria-label="Match id"
          />
          <button className="btn secondary" onClick={onJoin} disabled={busy || !joinId}>
            Join
          </button>
        </div>
      </div>

      {error && (
        <div className="chip danger" style={{ alignSelf: "stretch", justifyContent: "center", padding: "10px" }}>
          {error}
        </div>
      )}
    </div>
  );
}
