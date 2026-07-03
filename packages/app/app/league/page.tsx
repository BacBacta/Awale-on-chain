"use client";

import { Icon } from "../../src/components/Icon.js";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { readContract, waitForTransactionReceipt } from "viem/actions";
import { parseUnits, type Address, type Hex } from "viem";
import { getInjectedProvider, connect, publicClient } from "../../src/lib/minipay.js";
import { escrowConfig } from "../../src/lib/escrow.js";
import {
  harvestVaultAbi,
  faucetAbi,
  harvestAddress,
  LEAGUE_SEASON,
  SEASON_STATUS,
  countdown,
  type Season,
} from "../../src/lib/league.js";
import { fmt } from "../../src/lib/money.js";
import { humanizeError } from "../../src/lib/errors.js";
import { erc20Abi } from "../../../protocol/src/abis.js";

const STAKE_DECIMALS = Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "18");
const SYMBOL = "aUSD";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wallet = any;

export default function League() {
  const vault = harvestAddress();
  const cfg = escrowConfig();
  const [season, setSeason] = useState<Season | null>(null);
  const [mine, setMine] = useState<bigint>(0n);
  const [balance, setBalance] = useState<bigint>(0n);
  const [amount, setAmount] = useState("5");
  const [account, setAccount] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prize, setPrize] = useState<{ amount: bigint; proof: Hex[] } | null>(null);

  // Prefill the deposit from a win's "grow winnings" link (?deposit=N).
  useEffect(() => {
    const d = new URLSearchParams(window.location.search).get("deposit");
    if (d && Number(d) > 0) {
      setAmount(d);
      setStatus("Deposit your winnings to grow them — your principal always returns in full.");
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!vault || !cfg) return;
    const client = publicClient(cfg.rpcUrl, cfg.chainId);
    const s = (await readContract(client, {
      address: vault,
      abi: harvestVaultAbi,
      functionName: "getSeason",
      args: [LEAGUE_SEASON],
    })) as Season;
    setSeason(s);
    if (account) {
      const [p, b] = await Promise.all([
        readContract(client, { address: vault, abi: harvestVaultAbi, functionName: "principalOf", args: [LEAGUE_SEASON, account] }),
        readContract(client, { address: s.token, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      ]);
      setMine(p as bigint);
      setBalance(b as bigint);
    }
  }, [vault, cfg, account]);

  useEffect(() => {
    if (!vault || !cfg) return;
    const provider = getInjectedProvider();
    if (provider) {
      connect(provider, cfg.chainId)
        .then(({ wallet, address }) => {
          setWallet(wallet);
          setAccount(address);
        })
        .catch(() => {});
    }
  }, [vault, cfg]);

  useEffect(() => {
    // a failed background read is not the player's problem — the page renders
    // without it, and any *action* they take reports its own error
    refresh().catch(() => {});
  }, [refresh]);

  // Once finalized, pull this player's prize (amount + Merkle proof) from the
  // published standings file written by the finalize tool.
  useEffect(() => {
    if (!account || season?.status !== SEASON_STATUS.Finalized) return;
    fetch(`/league/prizes-${LEAGUE_SEASON.toString()}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { claims?: Record<string, { amount: string; proof: Hex[] }> } | null) => {
        const c = data?.claims?.[account.toLowerCase()];
        setPrize(c ? { amount: BigInt(c.amount), proof: c.proof } : null);
      })
      .catch(() => setPrize(null));
  }, [account, season]);

  async function tx(label: string, run: () => Promise<`0x${string}`>) {
    if (!cfg) return;
    setBusy(true);
    setError(null);
    setStatus(`${label}…`);
    try {
      const hash = await run();
      await waitForTransactionReceipt(publicClient(cfg.rpcUrl, cfg.chainId), { hash });
      setStatus(`${label} ✓`);
      await refresh();
    } catch (e) {
      setError(humanizeError(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  async function faucet() {
    if (!wallet || !account || !season) return;
    await tx("Minting test aUSD", () =>
      wallet.writeContract({
        address: season.token,
        abi: faucetAbi,
        functionName: "mint",
        args: [account, parseUnits("100", STAKE_DECIMALS)],
      }),
    );
  }

  async function deposit() {
    if (!wallet || !account || !season || !vault) return;
    const amt = parseUnits((amount || "0") as `${number}`, STAKE_DECIMALS);
    if (amt <= 0n) return setError("Enter an amount greater than zero.");
    if (amt > balance) return setError(`Not enough ${SYMBOL} — use the faucet first.`);
    await tx("Depositing", async () => {
      const client = publicClient(cfg!.rpcUrl, cfg!.chainId);
      const allowance = (await readContract(client, {
        address: season.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, vault],
      })) as bigint;
      if (allowance < amt) {
        const ah = await wallet.writeContract({
          address: season.token,
          abi: erc20Abi,
          functionName: "approve",
          args: [vault, amt],
        });
        await waitForTransactionReceipt(client, { hash: ah });
      }
      return wallet.writeContract({ address: vault, abi: harvestVaultAbi, functionName: "deposit", args: [LEAGUE_SEASON, amt] });
    });
  }

  async function claimPrincipal() {
    if (!wallet || !vault) return;
    await tx("Claiming principal", () =>
      wallet.writeContract({ address: vault, abi: harvestVaultAbi, functionName: "claimPrincipal", args: [LEAGUE_SEASON] }),
    );
  }

  async function claimPrize() {
    if (!wallet || !vault || !prize) return;
    await tx("Claiming prize", () =>
      wallet.writeContract({
        address: vault,
        abi: harvestVaultAbi,
        functionName: "claimPrize",
        args: [LEAGUE_SEASON, prize.amount, prize.proof],
      }),
    );
    setPrize(null);
  }

  if (!vault) {
    return (
      <main className="pad stack" style={{ flex: 1, gap: 14 }}>
        <span className="title">Season</span>
        <div className="card stack" style={{ gap: 10, alignItems: "center", textAlign: "center" }}>
          <span className="lead gold" style={{ width: 52, height: 52, borderRadius: 16 }}>
            <Icon name="trophy" size={26} />
          </span>
          <span className="h2">Coming soon</span>
          <span className="muted">
            Put money in for the season, play games, and share the prize pool — you always get your deposit back in
            full. The league isn’t configured on this deployment yet.
          </span>
          <Link className="btn block" href="/" style={{ marginTop: 4 }}>
            Back to lobby
          </Link>
        </div>
      </main>
    );
  }

  const open = season?.status === SEASON_STATUS.Open;
  const finalized = season?.status === SEASON_STATUS.Finalized;
  const depositsOpen = open && season != null && Number(season.depositDeadline) * 1000 > Date.now();

  return (
    <main className="pad stack" style={{ flex: 1, gap: 14 }}>
      <span className="title">Season</span>

      <div className="card stack animate-in" style={{ gap: 10 }}>
        <div className="row">
          <span className="chip gold" style={{ alignSelf: "flex-start" }}>
            Season #{LEAGUE_SEASON.toString()}
          </span>
          {season && (
            <span className={`chip ${open ? "positive" : ""}`}>
              {finalized ? "Finalized" : depositsOpen ? `Deposits ${countdown(season.depositDeadline)}` : open ? "In play" : "—"}
            </span>
          )}
        </div>
        <span className="muted">
          {depositsOpen
            ? `Deposit ${SYMBOL} for the season, climb the ladder, and share the season’s prize pool. Your deposit is always returned in full — you can only win.`
            : "A no-loss savings league: deposit during the entry window, play the season, and share the prize pool. Your deposit always comes back in full."}
        </span>
        {/* the numbers row earns its place only when there's a number to show —
            "Pool 0 · Your stake 0" reads as a dead feature */}
        {season && (mine > 0n || season.totalPrincipal > 0n) && (
          <div className="card flat row" style={{ padding: "10px 12px" }}>
            <span className="muted">
              Pool <b style={{ color: "var(--text)" }}>{fmt(season.totalPrincipal, STAKE_DECIMALS)}</b> {SYMBOL}
            </span>
            <span className="muted">
              Your stake{" "}
              <b style={{ color: "var(--accent)" }}>
                {fmt(mine, STAKE_DECIMALS)} {SYMBOL}
              </b>
            </span>
          </div>
        )}
      </div>

      {!account ? (
        <div className="card muted">Open in MiniPay to join the league.</div>
      ) : finalized ? (
        <div className="stack" style={{ gap: 10 }}>
          <div className="card row">
            <span className="muted">Season yield</span>
            <span className="title score">
              {fmt(season!.yieldPot, STAKE_DECIMALS)} {SYMBOL}
            </span>
          </div>
          {prize && prize.amount > 0n && (
            <button className="btn block" onClick={claimPrize} disabled={busy}>
              <Icon name="trophy" size={17} /> Claim your {fmt(prize.amount, STAKE_DECIMALS)} {SYMBOL} prize
            </button>
          )}
          <button
            className={`btn ${prize && prize.amount > 0n ? "secondary" : ""} block`}
            onClick={claimPrincipal}
            disabled={busy || mine === 0n}
          >
            {mine === 0n ? "Principal claimed" : `Claim your ${fmt(mine, STAKE_DECIMALS)} ${SYMBOL} back`}
          </button>
          <span className="faint" style={{ textAlign: "center" }}>
            {prize && prize.amount > 0n
              ? "You placed in the standings — claim your prize and your principal."
              : "Prizes go to the top of the final standings. Your principal always returns in full."}
          </span>
        </div>
      ) : !depositsOpen ? (
        mine > 0n ? (
          // depositor mid-season: their money is riding — the action is to play
          <div className="card stack" style={{ gap: 10, alignItems: "center", textAlign: "center" }}>
            <span className="h2">Your deposit is in play</span>
            <span className="muted">
              Keep winning games to climb the standings before the season ends — your{" "}
              {fmt(mine, STAKE_DECIMALS)} {SYMBOL} comes back in full either way.
            </span>
            <Link className="btn block" href="/?play=1" style={{ marginTop: 4 }}>
              <Icon name="play" size={17} /> Play a game
            </Link>
          </div>
        ) : (
          // not in this season and can't join it — don't fake an action (games
          // won here earn a non-depositor nothing); hand them the money event
          // that IS live for them instead
          <div className="card stack" style={{ gap: 10, alignItems: "center", textAlign: "center" }}>
            <span className="h2">This season started without you</span>
            <span className="muted">
              Deposits reopen when the next season starts. Meanwhile, the weekly league pays out every Monday — no
              deposit needed, every money game counts.
            </span>
            <Link className="btn block" href="/compete" style={{ marginTop: 4 }}>
              <Icon name="trophy" size={17} /> Join this week&apos;s race
            </Link>
          </div>
        )
      ) : (
        <div className="card stack" style={{ gap: 12 }}>
          <div className="row">
            <span className="h2">Deposit</span>
            <span className="faint">
              Balance {fmt(balance, STAKE_DECIMALS)} {SYMBOL}
            </span>
          </div>
          <div className="row input" style={{ gap: 6 }}>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              aria-label="Deposit amount"
              style={{ background: "transparent", border: "none", color: "var(--text)", width: "100%", outline: "none" }}
            />
            <span className="muted" style={{ fontWeight: 700 }}>
              {SYMBOL}
            </span>
          </div>
          <button className="btn block" onClick={deposit} disabled={busy}>
            Deposit {amount || "0"} {SYMBOL}
          </button>
          <button className="btn secondary block" onClick={faucet} disabled={busy}>
            Get test {SYMBOL} (faucet)
          </button>
        </div>
      )}

      <Link href="/guide#season" className="faint" style={{ alignSelf: "center", fontSize: 12.5 }}>
        How the season works →
      </Link>

      {status && <span className="muted">{status}</span>}
      {error && (
        <div className="chip danger" style={{ alignSelf: "stretch", justifyContent: "center", padding: 10 }}>
          {error}
        </div>
      )}
    </main>
  );
}
