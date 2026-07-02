"use client";

import { Icon } from "../../src/components/Icon.js";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { readContract, waitForTransactionReceipt } from "viem/actions";
import { parseUnits, type Address } from "viem";
import { getInjectedProvider, connect, publicClient } from "../../src/lib/minipay.js";
import { escrowConfig } from "../../src/lib/escrow.js";
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

  const refresh = useCallback(async () => {
    if (!cos || !cfg) return;
    const client = publicClient(cfg.rpcUrl, cfg.chainId);
    setCurrency((await readContract(client, { address: cos, abi: cosmeticsAbi, functionName: "currency" })) as Address);
    if (!account) return;
    const paid = [...BOARD_SKINS, ...SEED_SKINS].filter((s) => s.itemId > 0);
    const bals = await Promise.all(
      paid.map((s) =>
        readContract(client, { address: cos, abi: cosmeticsAbi, functionName: "balanceOf", args: [account, BigInt(s.itemId)] }),
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

  useEffect(() => {
    refresh().catch((e) => setError(humanizeError(e)));
  }, [refresh]);

  async function run(label: string, fn: () => Promise<`0x${string}`>) {
    if (!cfg) return;
    setBusy(true);
    setError(null);
    setStatus(`${label}…`);
    try {
      const h = await fn();
      await waitForTransactionReceipt(publicClient(cfg.rpcUrl, cfg.chainId), { hash: h });
      setStatus(`${label} ✓`);
      await refresh();
    } catch (e) {
      setError(humanizeError(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  function faucet() {
    if (!wallet || !account || !currency) return;
    void run("Minting test aUSD", () =>
      wallet.writeContract({ address: currency, abi: faucetAbi, functionName: "mint", args: [account, parseUnits("100", DECIMALS)] }),
    );
  }

  function buy(s: Skin) {
    if (!wallet || !account || !cos || !currency || !s.price) return;
    const cost = parseUnits(String(s.price), DECIMALS);
    void run(`Buying ${s.name}`, async () => {
      const client = publicClient(cfg!.rpcUrl, cfg!.chainId);
      const allowance = (await readContract(client, {
        address: currency,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, cos],
      })) as bigint;
      if (allowance < cost) {
        const ah = await wallet.writeContract({ address: currency, abi: erc20Abi, functionName: "approve", args: [cos, cost] });
        await waitForTransactionReceipt(client, { hash: ah });
      }
      return wallet.writeContract({ address: cos, abi: cosmeticsAbi, functionName: "buy", args: [BigInt(s.itemId), 1n] });
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
          {s.itemId === 0 ? (
            <span className="faint">Free</span>
          ) : (
            <span className="faint">
              {s.price} {SYMBOL}
            </span>
          )}
        </div>
        {eq ? (
          <span className="chip positive" style={{ justifyContent: "center" }}>
            <span className="dot" /> Equipped
          </span>
        ) : own ? (
          <button className="btn secondary" onClick={() => choose(s)} disabled={busy}>
            Equip
          </button>
        ) : (
          <button className="btn" onClick={() => buy(s)} disabled={busy || !account}>
            Buy
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
        <div className="chip danger" style={{ alignSelf: "stretch", justifyContent: "center", padding: 10 }}>
          {error}
        </div>
      )}
    </main>
  );
}
