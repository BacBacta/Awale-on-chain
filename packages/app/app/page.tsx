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
import { HeroBoard } from "../src/components/HeroBoard.js";
import { Welcome } from "../src/components/Welcome.js";
import { HowItWorks } from "../src/components/HowItWorks.js";
import { streakCount, solvedToday } from "../src/lib/daily.js";

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
  const [streak, setStreak] = useState(0);
  const [didDaily, setDidDaily] = useState(true);
  const cfg: EscrowConfig | null = escrowConfig();

  useEffect(() => {
    try {
      setShowLearnHint(localStorage.getItem("awale_tutorial_seen") !== "1");
    } catch {
      /* ignore */
    }
    setStreak(streakCount());
    setDidDaily(solvedToday());
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
      <Welcome />
      {/* header: brand + identity */}
      <div className="row">
        <span className="brand" style={{ fontSize: 26 }}>
          Awalé
        </span>
        <span style={{ display: "none" }}>v30</span>
        <span className="row" style={{ gap: 6 }}>
          {streak > 0 && (
            <Link href="/daily" className="chip gold" style={{ textDecoration: "none" }} title="Daily puzzle streak">
              🔥 {streak}
            </Link>
          )}
          {address ? (
            <Link href="/profile" className="chip positive" title={shortAddress(address)} style={{ textDecoration: "none" }}>
              <span className="dot" />
              {friendlyName(address)}
            </Link>
          ) : (
            <span className="chip">
              <span className={`dot ${inMiniPay ? "pulse" : ""}`} />
              {inMiniPay ? "Connecting…" : "Open in MiniPay"}
            </span>
          )}
        </span>
      </div>

      {/* hero — a calm, living board behind the headline */}
      <div className="card animate-in" style={{ position: "relative", overflow: "hidden", padding: 18, minHeight: 168 }}>
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0.28,
            display: "grid",
            placeItems: "center",
            filter: "blur(5px)",
            WebkitMaskImage: "radial-gradient(130% 75% at 50% 28%, #000 30%, transparent 70%)",
            maskImage: "radial-gradient(130% 75% at 50% 28%, #000 30%, transparent 70%)",
          }}
        >
          <div style={{ width: "168%", transform: "translateY(-22%)" }}>
            <HeroBoard />
          </div>
        </div>
        <div
          aria-hidden
          style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(11,10,8,0.3), rgba(11,10,8,0.86))" }}
        />
        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="display" style={{ fontSize: 32, textShadow: "0 2px 16px rgba(0,0,0,0.6)" }}>
            Play Awalé, win real money
          </span>
          <span className="muted">Sow, capture, win the pot. Play free, or put a few dollars on a match.</span>
        </div>
      </div>

      {/* primary action */}
      <QuickMatch account={address ?? undefined} />

      {/* stake-a-match (when connected) */}
      {staking &&
        (verified ? (
          <MatchActions wallet={wallet} account={address} cfg={cfg} />
        ) : (
          <PersonhoodVerify account={address} onVerified={() => setVerified(true)} />
        ))}

      {/* secondary — only what isn't already in the bottom nav */}
      <div className="stack" style={{ gap: 8 }}>
        <NavRow
          href="/daily"
          icon="bolt"
          tone={didDaily ? "neutral" : "gold"}
          title="Daily puzzle"
          sub={didDaily ? `Solved · ${streak}-day streak 🔥` : streak > 0 ? `Keep your ${streak}-day streak 🔥` : "Solve one capture a day"}
        />
        <NavRow href="/play" icon="play" title="Practice vs AI" sub="Pick your level — always free" />
        <NavRow
          href="/learn"
          icon="info"
          tone={showLearnHint ? "gold" : "neutral"}
          title="How to play"
          sub={showLearnHint ? "New here? Learn in 30 seconds" : "Sowing, capturing, winning"}
        />
        <HowItWorks />
      </div>

      <div className="spacer" />
      <a className="btn ghost block" href={addCashDeeplink()} style={{ gap: 8 }}>
        <Icon name="wallet" size={16} /> Add money
      </a>
    </main>
  );
}
