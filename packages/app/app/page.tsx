"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { getInjectedProvider, isMiniPay, connect } from "../src/lib/minipay.js";
import { addCashDeeplink } from "../src/lib/deeplinks.js";
import { shortAddress } from "../src/lib/identity.js";
import { escrowConfig, type WriteClient, type EscrowConfig } from "../src/lib/escrow.js";
import { MatchActions } from "../src/components/MatchActions.js";
import { PersonhoodVerify } from "../src/components/PersonhoodVerify.js";
import { QuickMatch } from "../src/components/QuickMatch.js";

const SELF_CONFIGURED = Boolean(process.env.NEXT_PUBLIC_SELF_SCOPE && process.env.NEXT_PUBLIC_SELF_ENDPOINT);

export default function Lobby() {
  const [address, setAddress] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<WriteClient | null>(null);
  const [inMiniPay, setInMiniPay] = useState(false);
  const [verified, setVerified] = useState(!SELF_CONFIGURED);
  const [showLearnHint, setShowLearnHint] = useState(false);
  const cfg: EscrowConfig | null = escrowConfig();

  // First-run: offer the tutorial to players who've never seen it.
  useEffect(() => {
    try {
      setShowLearnHint(localStorage.getItem("awale_tutorial_seen") !== "1");
    } catch {
      /* ignore */
    }
  }, []);

  // Zero-click connect: auto-connect from the injected wallet inside MiniPay.
  useEffect(() => {
    const provider = getInjectedProvider();
    setInMiniPay(isMiniPay(provider));
    if (!provider) return;
    connect(provider, cfg?.chainId)
      .then(({ wallet, address }) => {
        setWallet(wallet as unknown as WriteClient);
        setAddress(address);
      })
      .catch(() => {
        /* not connected yet — stay on the lobby */
      });
  }, []);

  return (
    <main className="pad stack" style={{ flex: 1, gap: 16 }}>
      <div className="row">
        <span className="row" style={{ gap: 8 }}>
          <span className="brand" style={{ fontSize: 26 }}>
            Awalé
          </span>
          <span className="chip gold" style={{ fontSize: 10 }}>
            v15
          </span>
        </span>
        {address ? (
          <span className="chip positive" title={address}>
            <span className="dot" />
            {shortAddress(address)}
          </span>
        ) : (
          <span className="chip">
            <span className={`dot ${inMiniPay ? "pulse" : ""}`} />
            {inMiniPay ? "Connecting…" : "Open in MiniPay"}
          </span>
        )}
      </div>

      {cfg && wallet && address ? (
        verified ? (
          <MatchActions wallet={wallet} account={address} cfg={cfg} />
        ) : (
          <PersonhoodVerify account={address} onVerified={() => setVerified(true)} />
        )
      ) : (
        <>
          <div className="card animate-in" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span className="chip gold" style={{ alignSelf: "flex-start" }}>
              One of the oldest games on Earth
            </span>
            <span className="display">Play Awalé for stablecoin</span>
            <span className="muted">
              Sow, capture, and win the pot. Non-custodial · winner takes the stake, minus a small protocol fee.
            </span>
          </div>
          <Link className="btn secondary block" href="/play">
            Play a demo game
          </Link>
        </>
      )}

      <QuickMatch account={address ?? undefined} />

      <a className="btn secondary block" href={addCashDeeplink()}>
        Deposit stablecoin
      </a>

      <Link className={`btn ${showLearnHint ? "" : "secondary"} block`} href="/learn">
        {showLearnHint ? "🌱 New here? Learn to play" : "How to play"}
      </Link>

      <div className="spacer" />
    </main>
  );
}
