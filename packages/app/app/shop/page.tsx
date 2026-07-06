"use client";

// Style shop. Two hard rules, learned the hard way:
//  1. NOTHING may change size after mount — every slot (header chip, card
//     rows, action buttons, status line) has a fixed height, so the grid
//     never reflows mid-purchase ("the page won't stop moving").
//  2. Money language only — prices are "$0.25", steps say "Preparing
//     payment", never token symbols, approvals or chain jargon. The raw
//     error detail goes to the console, not the screen.

import { Icon } from "../../src/components/Icon.js";
import { STAKE_DECIMALS } from "../../src/lib/stake.js";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { readContract } from "viem/actions";
import { parseUnits, type Address } from "viem";
import { getInjectedProvider, connect, publicClient, effectiveFeeCurrency } from "../../src/lib/minipay.js";
import { escrowConfig } from "../../src/lib/escrow.js";
import { readWithRetry, sendWithStaleRetry, confirmTx } from "../../src/lib/tx.js";
import { cardState, isUnlocked, purchaseCost, priceTag, type CatalogEntry } from "../../src/lib/shop-logic.js";
import {
  BOARD_SKINS,
  SEED_SKINS,
  cosmeticsAddress,
  cosmeticsAbi,
  getEquipped,
  equip,
  type Skin,
} from "../../src/lib/skins.js";
import { faucetAbi } from "../../src/lib/league.js";
import { humanizeError } from "../../src/lib/errors.js";
import { getProfile, TIERS } from "../../src/lib/profile.js";
import { erc20Abi } from "../../../protocol/src/abis.js";

const tierIndex = (name?: string) => (name ? TIERS.findIndex((t) => t.name === name) : -1);

const DECIMALS = STAKE_DECIMALS;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wallet = any;

export default function Shop() {
  const cos = cosmeticsAddress();
  const cfg = escrowConfig();
  const [account, setAccount] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [owned, setOwned] = useState<Record<number, boolean>>({});
  const [equipped, setEquippedState] = useState(getEquipped());
  const [currency, setCurrency] = useState<Address | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Record<number, CatalogEntry>>({});
  // the player's rank index in the TIERS ladder (null until known) — drives the
  // status gate: a Grandmaster skin shows "reach 👑 Grandmaster to unlock"
  // until you're there.
  const [playerRank, setPlayerRank] = useState<number | null>(null);

  // Gas paid in stablecoin inside MiniPay (its users hold no CELO); native gas
  // everywhere else. Use ONLY an explicitly-configured CIP-64 adapter — never
  // fall back to the purchase currency: it's a mock, not a registered fee
  // currency, so paying gas in it makes MiniPay reject the tx at estimation.
  const feeCurrency = useCallback(
    () => effectiveFeeCurrency((process.env.NEXT_PUBLIC_FEE_CURRENCY as Address) || undefined),
    [],
  );

  const refresh = useCallback(async () => {
    if (!cos || !cfg) return;
    const client = publicClient(cfg.rpcUrl, cfg.chainId);
    const paid = [...BOARD_SKINS, ...SEED_SKINS].filter((s) => s.itemId > 0);

    // ONE multicall for everything (currency + catalogue + ownership):
    // separate eth_calls exhausted the public backup endpoints' rate limits.
    const calls = [
      { address: cos, abi: cosmeticsAbi, functionName: "currency" as const },
      ...paid.map((s) => ({ address: cos, abi: cosmeticsAbi, functionName: "items" as const, args: [BigInt(s.itemId)] })),
      ...(account
        ? paid.map((s) => ({ address: cos, abi: cosmeticsAbi, functionName: "balanceOf" as const, args: [account, BigInt(s.itemId)] }))
        : []),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await readWithRetry(() => client.multicall({ contracts: calls as any, allowFailure: true }));

    const cur = res[0];
    if (cur?.status === "success") setCurrency(cur.result as Address);

    const cat: Record<number, CatalogEntry> = {};
    paid.forEach((s, i) => {
      const r = res[1 + i];
      if (r?.status !== "success") return;
      const [exists, price, maxSupply, minted] = r.result as readonly [boolean, bigint, bigint, bigint];
      cat[s.itemId] = { onSale: exists && price > 0n, price, left: maxSupply > 0n ? Number(maxSupply - minted) : null };
    });
    setCatalog(cat);

    if (!account) return;
    const o: Record<number, boolean> = {};
    paid.forEach((s, i) => {
      const r = res[1 + paid.length + i];
      if (r?.status === "success") o[s.itemId] = (r.result as bigint) > 0n;
    });
    setOwned(o);
  }, [cos, cfg, account]);

  useEffect(() => {
    if (!cos || !cfg) return;
    const p = getInjectedProvider();
    if (p)
      connect(p, cfg.chainId)
        .then(({ wallet, address }) => {
          setWallet(wallet);
          setAccount(address);
        })
        .catch(() => {});
  }, [cos, cfg]);

  // Desktop wallets (MetaMask & co) return no address until the user approves
  // the site — a passive mount leaves `account` null and the Buy button
  // permanently disabled. Prompt on intent, from a button.
  async function connectInteractive() {
    if (!cfg) return;
    const p = getInjectedProvider();
    if (!p) return;
    try {
      const c = await connect(p, cfg.chainId, { interactive: true });
      setWallet(c.wallet);
      setAccount(c.address);
    } catch {
      /* user declined */
    }
  }

  // the player's rank (for the status gate) — the durable server profile Elo,
  // same source as Compete and the ladder
  useEffect(() => {
    if (!account) return;
    getProfile(account)
      .then((prof) => {
        if (!prof || prof.gamesPlayed === 0) return setPlayerRank(0); // unranked = lowest tier
        let idx = 0;
        for (let i = 0; i < TIERS.length; i++) if (prof.elo >= TIERS[i].min) idx = i;
        setPlayerRank(idx);
      })
      .catch(() => setPlayerRank(0));
  }, [account]);

  useEffect(() => {
    // background refresh: fail silent — a red banner the user never caused
    // reads as "the app is broken". Errors only surface for their own actions.
    refresh().catch(() => {});
  }, [refresh]);

  /** Returns true iff the tx landed — callers flip local state on it. */
  async function run(label: string, fn: () => Promise<`0x${string}`>): Promise<boolean> {
    if (!cfg) return false;
    setBusy(true);
    setError(null);
    setStatus(`${label}…`);
    try {
      const h = await fn();
      setStatus("Finalizing…");
      await confirmTx(publicClient(cfg.rpcUrl, cfg.chainId), h, label);
      setStatus(`${label} ✓`);
      // the tx LANDED — a failed post-action refresh must never repaint the
      // success as an error. Ownership catches up on the next load anyway.
      refresh().catch(() => {});
      return true;
    } catch (e) {
      // the raw reason (revert / gas / RPC) belongs in the console, not the UI
      console.error("[shop]", label, e);
      setError(humanizeError(e));
      setStatus(null);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function faucet() {
    if (!wallet || !account || !currency) return;
    const fee = feeCurrency();
    void run("Adding test money", () =>
      sendWithStaleRetry("Mint", () =>
        wallet.writeContract({ address: currency, abi: faucetAbi, functionName: "mint", args: [account, parseUnits("100", DECIMALS)], account, feeCurrency: fee }),
      ),
    );
  }

  function buy(s: Skin) {
    if (!wallet || !account || !cos || !currency) return;
    const cost = purchaseCost(catalog[s.itemId], s.price, DECIMALS);
    if (cost <= 0n) return;
    const fee = feeCurrency();
    void run(`Buying ${s.name}`, async () => {
      const client = publicClient(cfg!.rpcUrl, cfg!.chainId);
      // the allowance read is the first RPC hop and the one flaky endpoints
      // drop most — retry it before giving up.
      const allowance = (await readWithRetry(() =>
        readContract(client, { address: currency, abi: erc20Abi, functionName: "allowance", args: [account, cos] }),
      )) as bigint;
      if (allowance < cost) {
        setStatus("Preparing payment (1/2)…");
        const ah = await sendWithStaleRetry("Payment setup", () =>
          // `account` names the signer (the wallet client is created unbound).
          // 20× headroom: one setup covers the whole catalogue, so later
          // purchases skip an entire tx + confirmation round.
          wallet.writeContract({ address: currency, abi: erc20Abi, functionName: "approve", args: [cos, cost * 20n], account, feeCurrency: fee }),
        );
        await confirmTx(client, ah, "Payment setup");
      }
      setStatus(`Buying ${s.name} (2/2)…`);
      return sendWithStaleRetry("Purchase", () =>
        wallet.writeContract({ address: cos, abi: cosmeticsAbi, functionName: "buy", args: [BigInt(s.itemId), 1n], account, feeCurrency: fee }),
      );
    }).then((ok) => {
      // the receipt is confirmed — the skin is provably theirs. Flip the card
      // to "Equip" NOW instead of waiting on a background refresh a flaky
      // RPC may delay: the buyer must never wonder whether the buy worked.
      if (ok) setOwned((o) => ({ ...o, [s.itemId]: true }));
    });
  }

  function choose(s: Skin) {
    equip(s);
    setEquippedState(getEquipped());
  }

  if (!cos) {
    return (
      <main className="pad stack" style={{ flex: 1, gap: 14 }}>
        <span className="title">Style</span>
        <div className="card stack" style={{ gap: 10, alignItems: "center", textAlign: "center" }}>
          <span className="lead" style={{ width: 52, height: 52, borderRadius: 16 }}>
            <Icon name="palette" size={26} />
          </span>
          <span className="h2">Coming soon</span>
          <span className="muted">Board and seed styles aren’t available here yet.</span>
          <Link className="btn block" href="/" style={{ marginTop: 4 }}>
            Back to lobby
          </Link>
        </div>
      </main>
    );
  }

  const Card = (s: Skin) => {
    const entry = catalog[s.itemId];
    // a champion trophy is never buyable — only owned (awarded) unlocks it
    const unlocked = !s.champion && isUnlocked(tierIndex(s.tier), playerRank);
    const state = cardState({
      itemId: s.itemId,
      owned: !!owned[s.itemId],
      equipped: s.kind === "board" ? equipped.wood === s.asset : equipped.seed === s.asset,
      hasAccount: !!account,
      unlocked,
      entry,
      fallbackPrice: s.price,
    });
    const scarce = entry?.left != null && entry.left > 0;
    const gateTier = s.tier ? TIERS[tierIndex(s.tier)] : null;
    // a locked prestige skin is shown but DIMMED — you see the prize you haven't
    // earned yet; that's the aspiration
    const dim = state === "locked";
    return (
      <div className="card stack" key={s.key} style={{ gap: 8, padding: 12, opacity: dim ? 0.82 : 1 }}>
        <div
          style={{
            height: 72,
            borderRadius: 10,
            position: "relative",
            background: s.kind === "board" ? `url(${s.asset}) center/cover` : "rgba(0,0,0,0.25)",
            filter: dim ? "grayscale(0.5) brightness(0.8)" : undefined,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
          }}
        >
          {s.kind === "seed" && <img src={s.asset} alt={s.name} width={48} height={48} style={{ filter: dim ? "grayscale(0.5)" : undefined }} />}
          {dim && <span style={{ position: "absolute", fontSize: 22 }}>🔒</span>}
          {/* desire badges, top-left of the art */}
          {(s.champion || s.limited) && (
            <span
              className="chip"
              style={{ position: "absolute", top: 6, left: 6, fontSize: 9.5, padding: "1px 6px", background: s.champion ? "rgba(246,200,99,0.9)" : "rgba(0,0,0,0.55)", color: s.champion ? "#1a1400" : "#fff", fontWeight: 800 }}
            >
              {s.champion ? "🏆 Champion" : "Limited"}
            </span>
          )}
        </div>
        {/* fixed-height rows: a card that resizes reflows the whole grid */}
        <div className="row" style={{ height: 22 }}>
          <span style={{ fontWeight: 700, fontSize: 13, whiteSpace: "nowrap" }}>{s.name}</span>
          {s.itemId === 0 ? <span className="faint">Free</span> : scarce ? <span className="chip gold" style={{ fontSize: 10 }}>Only {entry!.left} left</span> : null}
        </div>
        <div style={{ height: 40, display: "flex", alignItems: "stretch" }}>
          {state === "equipped" ? (
            <span className="chip positive" style={{ flex: 1, justifyContent: "center" }}>
              <span className="dot" /> Equipped
            </span>
          ) : state === "equip" ? (
            <button className="btn secondary" style={{ flex: 1, whiteSpace: "nowrap" }} onClick={() => choose(s)} disabled={busy}>
              Equip
            </button>
          ) : state === "connect" ? (
            <button className="btn secondary" style={{ flex: 1, whiteSpace: "nowrap", fontSize: 12.5 }} onClick={connectInteractive} disabled={busy}>
              Connect to buy
            </button>
          ) : state === "locked" ? (
            // aspiration, not a dead end: name the rank that unlocks it
            <span className="faint" style={{ flex: 1, alignSelf: "center", textAlign: "center", fontSize: 11.5, lineHeight: 1.15 }}>
              {s.champion ? "Win the weekly league" : `Reach ${gateTier?.icon ?? ""} ${s.tier}`}
            </span>
          ) : state === "sold-out" ? (
            <button className="btn secondary" style={{ flex: 1 }} disabled>
              Sold out
            </button>
          ) : state === "coming-soon" ? (
            <span className="faint" style={{ flex: 1, alignSelf: "center", textAlign: "center", fontSize: 12.5 }}>Coming soon</span>
          ) : (
            // quiet outline, price on the button: a shop full of shouting green
            // "Buy" reads as pressure, not premium — green stays for "Equipped"
            <button
              className="btn secondary"
              style={{ flex: 1, whiteSpace: "nowrap", fontSize: 12.5, padding: "0 8px" }}
              onClick={() => buy(s)}
              disabled={busy}
            >
              Buy · {priceTag(entry, s.price, DECIMALS)}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <main className="pad stack" style={{ flex: 1, gap: 14 }} data-build="sc12">
      {/* fixed-height header: the test-money chip pops in when the wallet
          connects — without a reserved slot that shifted the whole page */}
      <div className="row" style={{ height: 32 }}>
        <span className="title">Style</span>
        {account && currency && (
          <button className="chip" onClick={faucet} disabled={busy} style={{ cursor: "pointer" }}>
            + $100 test money
          </button>
        )}
      </div>

      <span className="h2">Boards</span>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>{BOARD_SKINS.map(Card)}</div>

      <span className="h2" style={{ marginTop: 6 }}>
        Seeds
      </span>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>{SEED_SKINS.map(Card)}</div>

      {/* reserved-height status area; the dot is ALWAYS in the line so the
          centered text never shifts sideways when busy toggles */}
      <div className="col" style={{ gap: 6, minHeight: 44, justifyContent: "center" }}>
        {status && (
          <span className="muted" style={{ textAlign: "center" }}>
            <span className={`dot ${busy ? "pulse" : ""}`} style={{ marginRight: 6 }} />
            {status}
          </span>
        )}
        {error && (
          <div className="chip danger" style={{ alignSelf: "stretch", justifyContent: "center", padding: 10 }}>
            {error}
          </div>
        )}
      </div>
    </main>
  );
}
