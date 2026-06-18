"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getInjectedProvider, isMiniPay, connect } from "../src/lib/minipay.js";
import { addCashDeeplink } from "../src/lib/deeplinks.js";
import { shortAddress } from "../src/lib/identity.js";

export default function Lobby() {
  const [address, setAddress] = useState<string | null>(null);
  const [inMiniPay, setInMiniPay] = useState(false);

  // Zero-click connect: auto-connect from the injected wallet inside MiniPay.
  useEffect(() => {
    const provider = getInjectedProvider();
    setInMiniPay(isMiniPay(provider));
    if (!provider) return;
    connect(provider)
      .then(({ address }) => setAddress(address))
      .catch(() => {
        /* not connected yet — stay on the lobby */
      });
  }, []);

  return (
    <main className="pad" style={{ display: "flex", flexDirection: "column", gap: 16, flex: 1 }}>
      <div className="row">
        <span className="title">Awalé</span>
        {address ? (
          <span className="muted" title={address}>
            {shortAddress(address)}
          </span>
        ) : (
          <span className="muted">{inMiniPay ? "Connecting…" : "Open in MiniPay"}</span>
        )}
      </div>

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="muted">Stake</span>
        <span className="title">Play for stablecoin</span>
        <span className="muted">Winner takes the pot, minus a small protocol fee.</span>
      </div>

      <Link className="btn" href="/play">
        Play a demo game
      </Link>

      <a className="btn secondary" href={addCashDeeplink()}>
        Deposit stablecoin
      </a>

      <div style={{ flex: 1 }} />

      <Link className="muted" href="/stats" style={{ textAlign: "center" }}>
        View stats
      </Link>
    </main>
  );
}
