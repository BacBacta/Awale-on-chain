"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { getInjectedProvider, isMiniPay, connect } from "../src/lib/minipay.js";
import { addCashDeeplink } from "../src/lib/deeplinks.js";
import { shortAddress } from "../src/lib/identity.js";
import { friendlyName } from "../src/lib/names.js";
import { escrowConfig, type WriteClient, type EscrowConfig } from "../src/lib/escrow.js";
import { MatchActions } from "../src/components/MatchActions.js";
import { PersonhoodVerify } from "../src/components/PersonhoodVerify.js";
import { QuickMatch } from "../src/components/QuickMatch.js";
import { Icon, type IconName } from "../src/components/Icon.js";

const SELF_CONFIGURED = Boolean(process.env.NEXT_PUBLIC_SELF_SCOPE && process.env.NEXT_PUBLIC_SELF_ENDPOINT);

function NavRow({
  href,
  external,
  icon,
  tone,
  title,
  sub,
}: {
  href: string;
  external?: boolean;
  icon: IconName;
  tone?: "gold" | "neutral";
  title: string;
  sub: string;
}) {
  const inner = (
    <>
      <span className={`lead ${tone ?? ""}`}>
        <Icon name={icon} size={19} />
      </span>
      <span className="col" style={{ flex: 1, gap: 1 }}>
        <span style={{ fontWeight: 700, fontSize: 14.5 }}>{title}</span>
        <span className="faint">{sub}</span>
      </span>
      <Icon name="arrowRight" size={16} style={{ color: "var(--faint)" }} />
    </>
  );
  return external ? (
    <a className="list-row" href={href}>
      {inner}
    </a>
  ) : (
    <Link className="list-row" href={href}>
      {inner}
    </Link>
  );
}

export default function Lobby() {
  const [address, setAddress] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<WriteClient | null>(null);
  const [inMiniPay, setInMiniPay] = useState(false);
  const [verified, setVerified] = useState(!SELF_CONFIGURED);
  const [showLearnHint, setShowLearnHint] = useState(false);
  const cfg: EscrowConfig | null = escrowConfig();

  useEffect(() => {
    try {
      setShowLearnHint(localStorage.getItem("awale_tutorial_seen") !== "1");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const provider = getInjectedProvider();
    setInMiniPay(isMiniPay(provider));
    if (!provider) return;
    connect(provider, cfg?.chainId)
      .then(({ wallet, address }) => {
        setWallet(wallet as unknown as WriteClient);
        setAddress(address);
      })
      .catch(() => {});
  }, []);

  const staking = cfg && wallet && address;

  return (
    <main className="pad" style={{ flex: 1, display: "flex", flexDirection: "column", gap: 18 }}>
      {/* header: brand + identity */}
      <div className="row">
        <span className="row" style={{ gap: 7 }}>
          <span className="brand" style={{ fontSize: 26 }}>
            Awalé
          </span>
          <span className="faint" style={{ fontSize: 9, opacity: 0.55, alignSelf: "flex-start", marginTop: 3 }}>
            v18
          </span>
        </span>
        {address ? (
          <span className="chip positive" title={shortAddress(address)}>
            <span className="dot" />
            {friendlyName(address)}
          </span>
        ) : (
          <span className="chip">
            <span className={`dot ${inMiniPay ? "pulse" : ""}`} />
            {inMiniPay ? "Connecting…" : "Open in MiniPay"}
          </span>
        )}
      </div>

      {/* hero */}
      <div
        className="card animate-in"
        style={{ display: "flex", flexDirection: "column", gap: 10, padding: 18, overflow: "hidden", position: "relative" }}
      >
        <div
          aria-hidden
          style={{
            position: "absolute",
            right: -40,
            top: -40,
            width: 160,
            height: 160,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(246,200,99,0.18), transparent 70%)",
          }}
        />
        <span className="chip gold" style={{ alignSelf: "flex-start" }}>
          One of the oldest games on Earth
        </span>
        <span className="display" style={{ fontSize: 34 }}>
          Play Awalé for stablecoin
        </span>
        <span className="muted">Sow, capture, win the pot. Non-custodial — winner takes the stake, minus a small fee.</span>
      </div>

      {/* primary action */}
      <QuickMatch account={address ?? undefined} />

      {/* stake-a-match (when connected) */}
      {staking &&
        (verified ? (
          <>
            <span className="section-label">Play for stablecoin</span>
            <MatchActions wallet={wallet} account={address} cfg={cfg} />
          </>
        ) : (
          <PersonhoodVerify account={address} onVerified={() => setVerified(true)} />
        ))}

      {/* secondary navigation */}
      <span className="section-label">Explore</span>
      <div className="stack stagger" style={{ gap: 8 }}>
        <NavRow href="/play" icon="play" title="Practice vs bot" sub="A quick game, no stake" />
        <NavRow
          href="/learn"
          icon="info"
          tone={showLearnHint ? "gold" : "neutral"}
          title="How to play"
          sub={showLearnHint ? "New here? Learn in 30 seconds" : "Sowing, capturing, winning"}
        />
        <NavRow href="/league" icon="trophy" tone="gold" title="No-loss League" sub="Deposit, climb, share the yield" />
        <NavRow href="/shop" icon="palette" title="Skins" sub="Board & seed cosmetics" />
        <NavRow href={addCashDeeplink()} external icon="wallet" tone="neutral" title="Deposit" sub="Add stablecoin to play" />
      </div>

      <div className="spacer" />
    </main>
  );
}
