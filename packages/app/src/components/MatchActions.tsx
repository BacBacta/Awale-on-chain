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
import { stakeTokens, preferredIndex } from "../lib/stakeTokens.js";
import { faucetAbi } from "../lib/league.js";
import { matchEscrowAbi, erc20Abi } from "../../../protocol/src/abis.js";

const TOKENS = stakeTokens();
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
  const [rakeBps, setRakeBps] = useState<number | null>(null); // null until confirmed — never show a made-up fee
  const [minStake, setMinStake] = useState<bigint>(0n);
  const [copied, setCopied] = useState(false);
  const [sel, setSel] = useState(0); // index into TOKENS

  const busy = step === "approving" || step === "staking";
  const tok = TOKENS[sel];
  const token = tok?.address;
  const dec = tok?.decimals ?? 18;
  const sym = tok?.symbol ?? "";
  const feeCurrency = tok?.feeCurrency;

  // Read balances across all stake tokens + the live rake; default to the
  // user's highest-balance token (preferred stablecoin). The reads are kept
  // independent: a failed balance read must never zero out the displayed fee
  // (a wrong number on a money screen is worse than a placeholder).
  useEffect(() => {
    if (TOKENS.length === 0) return;
    const client = publicClient(cfg.rpcUrl, cfg.chainId);
    readContract(client, { address: cfg.escrow, abi: matchEscrowAbi, functionName: "rakeBps" })
      .then((rake) => setRakeBps(Number(rake)))
      .catch(() => setRakeBps(null));
    readContract(client, { address: cfg.escrow, abi: matchEscrowAbi, functionName: "minStake" })
      .then((floor) => setMinStake(floor as bigint))
      .catch(() => {});
    Promise.all(
      TOKENS.map((t) => readContract(client, { address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [account] })),
    )
      .then((bals) => {
        const balances = bals as bigint[];
        const pref = preferredIndex(TOKENS, balances);
        setSel(pref);
        setBalance(balances[pref]);
      })
      .catch(() => {
        /* balance preview is best-effort */
      });
  }, [account, cfg]);

  // keep the displayed balance in sync with the selected token
  useEffect(() => {
    if (!token) return;
    const client = publicClient(cfg.rpcUrl, cfg.chainId);
    readContract(client, { address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] })
      .then((b) => setBalance(b as bigint))
      .catch(() => {});
  }, [sel, token, account, cfg]);

  async function onFaucet() {
    if (!tok?.faucet || !token || busy) return;
    setError(null);
    setStep("staking");
    try {
      const client = publicClient(cfg.rpcUrl, cfg.chainId);
      const hash = await wallet.writeContract({
        address: token,
        abi: faucetAbi,
        functionName: "mint",
        args: [account, parseStake("100", dec)],
        account,
        feeCurrency,
      });
      await client.waitForTransactionReceipt({ hash });
      const b = (await readContract(client, { address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] })) as bigint;
      setBalance(b);
      setStep("idle");
    } catch (e) {
      fail(e);
    }
  }

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
    const hash = await approve(wallet, { account, token, spender: cfg.escrow, amount, feeCurrency: feeCurrency });
    await client.waitForTransactionReceipt({ hash });
  }

  function fail(e: unknown) {
    setError(humanizeError(e));
    setStep("error");
  }

  async function onCreate() {
    if (!token || busy) return;
    setError(null);
    try {
      const amount = parseStake(stake, dec);
      if (amount <= 0n) return setError("Enter an amount greater than zero.");
      if (minStake > 0n && amount < minStake) return setError(`Minimum is ${fmt(minStake, dec)} ${sym}.`);
      if (balance !== null && amount > balance) return setError(`Not enough ${sym} — add money to MiniPay first.`);
      const client = publicClient(cfg.rpcUrl, cfg.chainId);
      const matchId = (await readContract(client, {
        address: cfg.escrow,
        abi: matchEscrowAbi,
        functionName: "nextMatchId",
      })) as bigint;

      const session = createSessionKey();
      persistSession(matchId, session);
      recordLocalMatch(matchId);

      await ensureAllowance(client, token, amount);
      setStep("staking");
      const hash = await createMatch(wallet, {
        account,
        escrow: cfg.escrow,
        token: token,
        stake: amount,
        session: session.address,
        feeCurrency: feeCurrency,
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
        feeCurrency: feeCurrency,
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
    const data = { title: "Awalé", text: `Join my Awalé match #${openId} for ${stake} ${sym}`, url };
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
      return parseStake(stake || "0", dec);
    } catch {
      return 0n;
    }
  })();
  const { pot, rake, prize } = computePayout(stakeRaw, rakeBps ?? 0);

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
            Pot {fmt(pot, dec)} {sym} · winner takes {fmt(prize, dec)}
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
              Balance {fmt(balance, dec)} {sym}
            </span>
          )}
        </div>

        {/* preferred-stablecoin selector (shows when several are configured) */}
        {TOKENS.length > 1 && (
          <div className="row" style={{ gap: 6 }}>
            {TOKENS.map((t, i) => (
              <button
                key={t.address}
                className={`chip ${i === sel ? "positive" : ""}`}
                onClick={() => setSel(i)}
                style={{ cursor: "pointer", flex: 1, justifyContent: "center", padding: "8px 0" }}
              >
                {t.symbol}
              </button>
            ))}
          </div>
        )}

        <div className="row" style={{ gap: 8 }}>
          <div className="row input" style={{ gap: 6 }}>
            <input
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              inputMode="decimal"
              aria-label="Amount"
              style={{ background: "transparent", border: "none", color: "var(--text)", width: "100%", outline: "none" }}
            />
            <span className="muted" style={{ fontWeight: 700 }}>
              {sym}
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

        {/* payout preview — mirrors MatchEscrow._payout. Until the live rake
            is confirmed on-chain, show a placeholder rather than a wrong 0%. */}
        <div className="card flat row" style={{ padding: "10px 12px" }}>
          <span className="muted">
            Pot <b style={{ color: "var(--text)" }}>{fmt(pot, dec)}</b>
          </span>
          <span className="muted">
            You win{" "}
            <b style={{ color: "var(--accent)" }}>
              {rakeBps === null ? "…" : `${fmt(prize, dec)} ${sym}`}
            </b>
          </span>
          <span className="faint">{rakeBps === null ? "fee …" : `fee ${fmt(rake, dec)} (${rakePct(rakeBps)})`}</span>
        </div>

        <button className="btn block" onClick={onCreate} disabled={busy || !token}>
          {step === "approving" ? "Confirm in wallet…" : step === "staking" ? "Adding to the pot…" : `Put ${stake || "0"} ${sym} in the pot`}
        </button>
        {tok?.faucet && (
          <button className="btn secondary block" onClick={onFaucet} disabled={busy}>
            Get test {sym} (faucet)
          </button>
        )}
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
