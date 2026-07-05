"use client";

import { Icon } from "../../src/components/Icon.js";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { readContract } from "viem/actions";
import { parseUnits, type Address } from "viem";
import { getInjectedProvider, connect, publicClient, effectiveFeeCurrency } from "../../src/lib/minipay.js";
import { escrowConfig } from "../../src/lib/escrow.js";
import { fmt } from "../../src/lib/money.js";
import { readWithRetry, sendWithStaleRetry, confirmTx } from "../../src/lib/tx.js";
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
import { erc20Abi } from "../../../protocol/src/abis.js";

const DECIMALS = 18;
const SYMBOL = "aUSD";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wallet = any;

// Pull the useful bits out of a viem/wallet error for on-screen diagnosis —
// shortMessage + details + the nested cause, which is where MiniPay's real
// revert/gas reason hides behind the humanized headline.
function rawErrorDetail(e: unknown): string | null {
  if (!e || typeof e !== "object") return typeof e === "string" ? e : null;
  const parts: string[] = [];
  const pick = (o: unknown, k: string) => {
    const v = o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
    if (typeof v === "string" && v) parts.push(v);
  };
  pick(e, "shortMessage");
  pick(e, "details");
  pick(e, "message");
  const cause = (e as { cause?: unknown }).cause;
  if (cause) {
    pick(cause, "shortMessage");
    pick(cause, "details");
    pick(cause, "message");
  }
  const seen = new Set<string>();
  const text = parts.filter((p) => (seen.has(p) ? false : seen.add(p))).join(" · ");
  return text ? text.slice(0, 400) : null;
}

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
  // raw error detail, surfaced under the humanized message — a generic
  // "Something went wrong" hides the actual revert/gas reason in MiniPay.
  const [detail, setDetail] = useState<string | null>(null);
  // on-chain catalogue per itemId: is it actually on sale, its real price, and
  // how many are left (null = unlimited). Until an item is created on-chain
  // (createItem) `onSale` is false and we show "Coming soon" rather than a Buy
  // button that would revert.
  const [catalog, setCatalog] = useState<Record<number, { onSale: boolean; price: bigint; left: number | null }>>({});

  // Gas paid in stablecoin inside MiniPay (its users hold no CELO); native gas
  // everywhere else. Use ONLY an explicitly-configured CIP-64 adapter — never
  // fall back to the purchase currency: aUSD is a mock, not a registered fee
  // currency, so paying gas in it makes MiniPay reject the tx at estimation.
  // Same contract the stake flow honours (NEXT_PUBLIC_FEE_CURRENCY or nothing).
  const feeCurrency = useCallback(
    () => effectiveFeeCurrency((process.env.NEXT_PUBLIC_FEE_CURRENCY as Address) || undefined),
    [],
  );

  const refresh = useCallback(async () => {
    if (!cos || !cfg) return;
    const client = publicClient(cfg.rpcUrl, cfg.chainId);
    setCurrency(
      (await readWithRetry(() => readContract(client, { address: cos, abi: cosmeticsAbi, functionName: "currency" }))) as Address,
    );
    const paid = [...BOARD_SKINS, ...SEED_SKINS].filter((s) => s.itemId > 0);

    // real catalogue state (price / supply / sold-out) — independent of wallet
    const rows = await Promise.all(
      paid.map((s) =>
        readWithRetry(() =>
          readContract(client, { address: cos, abi: cosmeticsAbi, functionName: "items", args: [BigInt(s.itemId)] }),
        ).catch(() => null),
      ),
    );
    const cat: Record<number, { onSale: boolean; price: bigint; left: number | null }> = {};
    paid.forEach((s, i) => {
      const r = rows[i] as readonly [boolean, bigint, bigint, bigint] | null;
      if (!r) return;
      const [exists, price, maxSupply, minted] = r;
      cat[s.itemId] = { onSale: exists && price > 0n, price, left: maxSupply > 0n ? Number(maxSupply - minted) : null };
    });
    setCatalog(cat);

    if (!account) return;
    const bals = await Promise.all(
      paid.map((s) =>
        readWithRetry(() =>
          readContract(client, { address: cos, abi: cosmeticsAbi, functionName: "balanceOf", args: [account, BigInt(s.itemId)] }),
        ),
      ),
    );
    const o: Record<number, boolean> = {};
    paid.forEach((s, i) => (o[s.itemId] = (bals[i] as bigint) > 0n));
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

  useEffect(() => {
    // background refresh: fail silent — a red banner the user never caused
    // reads as "the app is broken". Errors only surface for their own actions.
    refresh().catch(() => {});
  }, [refresh]);

  async function run(label: string, fn: () => Promise<`0x${string}`>) {
    if (!cfg) return;
    setBusy(true);
    setError(null);
    setDetail(null);
    setStatus(`${label}…`);
    try {
      const h = await fn();
      await confirmTx(publicClient(cfg.rpcUrl, cfg.chainId), h, label);
      setStatus(`${label} ✓`);
      await refresh();
    } catch (e) {
      setError(humanizeError(e));
      setDetail(rawErrorDetail(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  function faucet() {
    if (!wallet || !account || !currency) return;
    const fee = feeCurrency();
    void run("Minting test aUSD", () =>
      sendWithStaleRetry("Mint", () =>
        wallet.writeContract({ address: currency, abi: faucetAbi, functionName: "mint", args: [account, parseUnits("100", DECIMALS)], feeCurrency: fee }),
      ),
    );
  }

  function buy(s: Skin) {
    if (!wallet || !account || !cos || !currency) return;
    // charge the on-chain price when the item is created; fall back to the
    // hardcoded price only before the catalogue is read. Never let the app's
    // number diverge from what the contract actually charges.
    const chainPrice = catalog[s.itemId]?.price ?? 0n;
    const cost = chainPrice > 0n ? chainPrice : s.price ? parseUnits(String(s.price), DECIMALS) : 0n;
    if (cost <= 0n) return;
    const fee = feeCurrency();
    void run(`Buying ${s.name}`, async () => {
      const client = publicClient(cfg!.rpcUrl, cfg!.chainId);
      // the allowance read is the first RPC hop and was the exact step forno
      // dropped ("Failed to fetch") — retry it before giving up.
      const allowance = (await readWithRetry(() =>
        readContract(client, { address: currency, abi: erc20Abi, functionName: "allowance", args: [account, cos] }),
      )) as bigint;
      if (allowance < cost) {
        const ah = await sendWithStaleRetry("Approval", () =>
          wallet.writeContract({ address: currency, abi: erc20Abi, functionName: "approve", args: [cos, cost], feeCurrency: fee }),
        );
        await confirmTx(client, ah, "Approval");
      }
      return sendWithStaleRetry("Purchase", () =>
        wallet.writeContract({ address: cos, abi: cosmeticsAbi, functionName: "buy", args: [BigInt(s.itemId), 1n], feeCurrency: fee }),
      );
    });
  }

  function choose(s: Skin) {
    equip(s);
    setEquippedState(getEquipped());
  }

  function ownedBy(s: Skin) {
    return s.itemId === 0 || owned[s.itemId];
  }
  function isEquipped(s: Skin) {
    return s.kind === "board" ? equipped.wood === s.asset : equipped.seed === s.asset;
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
          <span className="muted">Board and seed styles aren’t available on this deployment yet.</span>
          <Link className="btn block" href="/" style={{ marginTop: 4 }}>
            Back to lobby
          </Link>
        </div>
      </main>
    );
  }

  const Card = (s: Skin) => {
    const own = ownedBy(s);
    const eq = isEquipped(s);
    const c = catalog[s.itemId];
    // real price once the item exists on-chain, else the hardcoded fallback
    const priceLabel = c && c.price > 0n ? fmt(c.price, DECIMALS) : s.price != null ? String(s.price) : "";
    const soldOut = c?.left === 0;
    // limited edition, some left → a quiet scarcity nudge (the desire lever)
    const scarce = c?.left != null && c.left > 0;
    return (
      <div className="card stack" key={s.key} style={{ gap: 8, padding: 12 }}>
        <div
          style={{
            height: 72,
            borderRadius: 10,
            background: s.kind === "board" ? `url(${s.asset}) center/cover` : "rgba(0,0,0,0.25)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
          }}
        >
          {s.kind === "seed" && <img src={s.asset} alt={s.name} width={48} height={48} />}
        </div>
        <div className="row">
          <span style={{ fontWeight: 700, fontSize: 13 }}>{s.name}</span>
          {s.itemId === 0 ? <span className="faint">Free</span> : scarce ? <span className="chip gold" style={{ fontSize: 10 }}>Only {c!.left} left</span> : null}
        </div>
        {eq ? (
          <span className="chip positive" style={{ justifyContent: "center" }}>
            <span className="dot" /> Equipped
          </span>
        ) : own ? (
          <button className="btn secondary" onClick={() => choose(s)} disabled={busy}>
            Equip
          </button>
        ) : !account ? (
          // no wallet yet — a passive mount never prompts desktop wallets
          <button className="btn secondary" onClick={connectInteractive} disabled={busy}>
            Connect to buy
          </button>
        ) : soldOut ? (
          <button className="btn secondary" disabled>
            Sold out
          </button>
        ) : c && !c.onSale ? (
          // item not created / priced on-chain yet — a Buy here would revert
          <span className="faint" style={{ textAlign: "center", padding: "8px 0", fontSize: 12.5 }}>Coming soon</span>
        ) : (
          // quiet outline, price on the button: a shop full of shouting green
          // "Buy" reads as pressure, not premium — green stays for "Equipped"
          <button className="btn secondary" onClick={() => buy(s)} disabled={busy}>
            Buy · {priceLabel} {SYMBOL}
          </button>
        )}
      </div>
    );
  };

  return (
    <main className="pad stack" style={{ flex: 1, gap: 14 }}>
      <div className="row">
        <span className="title">Style</span>
        {account && (
          <button className="chip" onClick={faucet} disabled={busy} style={{ cursor: "pointer" }}>
            + test {SYMBOL}
          </button>
        )}
      </div>

      <span className="h2">Boards</span>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>{BOARD_SKINS.map(Card)}</div>

      <span className="h2" style={{ marginTop: 6 }}>
        Seeds
      </span>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>{SEED_SKINS.map(Card)}</div>

      {status && <span className="muted">{status}</span>}
      {error && (
        <div className="col" style={{ gap: 6 }}>
          <div className="chip danger" style={{ alignSelf: "stretch", justifyContent: "center", padding: 10 }}>
            {error}
          </div>
          {detail && (
            <span className="faint" style={{ fontSize: 11, lineHeight: 1.4, wordBreak: "break-word", textAlign: "center" }}>
              {detail}
            </span>
          )}
        </div>
      )}
      <span className="faint" style={{ fontSize: 10, textAlign: "center", opacity: 0.5 }}>shop build sc5</span>
    </main>
  );
}
