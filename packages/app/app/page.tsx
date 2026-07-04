"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { getInjectedProvider, isMiniPay, connect } from "../src/lib/minipay.js";
import { shortAddress } from "../src/lib/identity.js";
import { friendlyName } from "../src/lib/names.js";
import { escrowConfig, type WriteClient, type EscrowConfig } from "../src/lib/escrow.js";
import { MatchActions } from "../src/components/MatchActions.js";
import { PersonhoodVerify } from "../src/components/PersonhoodVerify.js";
import { QuickMatch } from "../src/components/QuickMatch.js";
import { InboxCard } from "../src/components/InboxCard.js";
import { Icon, type IconName } from "../src/components/Icon.js";
import { HeroBoard } from "../src/components/HeroBoard.js";
import { Welcome } from "../src/components/Welcome.js";
import { HowItWorks } from "../src/components/HowItWorks.js";
import { streakCount, solvedToday } from "../src/lib/daily.js";
import { getProfile, rankFor, captureReferrer, claimReferral } from "../src/lib/profile.js";
import { track } from "../src/lib/analytics.js";

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
  // a wallet extension exists (e.g. MetaMask on desktop) but hasn't approved
  // the site yet — we can offer an explicit connect instead of "open MiniPay"
  const [hasProvider, setHasProvider] = useState(false);
  const [verified, setVerified] = useState(!SELF_CONFIGURED);
  const [showLearnHint, setShowLearnHint] = useState(false);
  const [streak, setStreak] = useState(0);
  const [didDaily, setDidDaily] = useState(true);
  const [showMoney, setShowMoney] = useState(false);
  // set when another screen links here to actually start something: ?play=1
  // auto-starts a quick match, ?money=1 opens the stake panel. Without these,
  // "Play your first game" / "Play for money" on Compete just bounced the
  // player to a home screen where nothing had happened.
  const [autoPlay, setAutoPlay] = useState(false);
  const moneyRef = useRef<HTMLDivElement | null>(null);
  // the ONE rank system (Seedling → Grandmaster) shown on the identity chip
  const [tierIcon, setTierIcon] = useState<string | null>(null);
  const cfg: EscrowConfig | null = escrowConfig();

  useEffect(() => {
    track("app_open");
    captureReferrer();
    try {
      setShowLearnHint(localStorage.getItem("awale_tutorial_seen") !== "1");
    } catch {
      /* ignore */
    }
    setStreak(streakCount());
    setDidDaily(solvedToday());
    const params = new URLSearchParams(window.location.search);
    if (params.get("play") === "1") setAutoPlay(true);
    if (params.get("money") === "1") setShowMoney(true);
  }, []);

  // when the stake panel opens from a ?money=1 deep link, bring it into view —
  // it sits below the fold, so just expanding it isn't enough to feel like the
  // button did something
  useEffect(() => {
    if (showMoney && moneyRef.current) {
      moneyRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [showMoney]);

  useEffect(() => {
    const provider = getInjectedProvider();
    setInMiniPay(isMiniPay(provider));
    setHasProvider(!!provider);
    if (!provider) return;
    connect(provider, cfg?.chainId)
      .then(async ({ wallet, address }) => {
        setWallet(wallet as unknown as WriteClient);
        setAddress(address);
        claimReferral(address);
        // the server-side profile may hold a longer streak than this device
        const p = await getProfile(address);
        if (p && p.streak > 0) setStreak((s) => Math.max(s, p.streak));
        if (p && p.gamesPlayed > 0) setTierIcon(rankFor(p.elo).icon);
        if (SELF_CONFIGURED && p?.verified) setVerified(true); // don't re-prompt

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
              {tierIcon ?? <span className="dot" />}
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

      {/* what happened while you were away — push's guaranteed fallback */}
      <InboxCard address={address} />

      {/* hero — tight: the headline earns ~2 lines, not a quarter of the screen */}
      <div className="card animate-in" style={{ position: "relative", overflow: "hidden", padding: "16px 18px" }}>
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0.22,
            display: "grid",
            placeItems: "center",
            filter: "blur(5px)",
            WebkitMaskImage: "radial-gradient(130% 75% at 50% 28%, #000 30%, transparent 70%)",
            maskImage: "radial-gradient(130% 75% at 50% 28%, #000 30%, transparent 70%)",
          }}
        >
          <div style={{ width: "168%", transform: "translateY(-30%)" }}>
            <HeroBoard />
          </div>
        </div>
        <div
          aria-hidden
          style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(11,10,8,0.3), rgba(11,10,8,0.86))" }}
        />
        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="display" style={{ fontSize: 24, textShadow: "0 2px 16px rgba(0,0,0,0.6)" }}>
            Play Awalé, win real money
          </span>
          <span className="muted" style={{ fontSize: 13 }}>
            Play free, or put a few dollars on a match.
          </span>
        </div>
      </div>

      {/* THE decision, sized by importance: one dominant button, two smaller
          siblings. Everything below this block is habit or help — visibly
          lighter, so the screen reads as a game, not a menu. */}
      <div className="stack" style={{ gap: 10 }}>
        <QuickMatch account={address ?? undefined} autoStart={autoPlay} />
        <div className="row" style={{ gap: 8 }}>
          <Link className="btn secondary" href="/matches" style={{ flex: 1, justifyContent: "center", gap: 6, padding: "10px 12px" }}>
            <span className="col" style={{ gap: 2, alignItems: "center" }}>
              <span className="row" style={{ gap: 6 }}>
                <Icon name="versus" size={15} /> With a friend
              </span>
              <span style={{ fontSize: 10.5, fontWeight: 500, opacity: 0.65 }}>Share a link · play anytime</span>
            </span>
          </Link>
          <button
            className="btn secondary"
            style={{ flex: 1, justifyContent: "center", gap: 6, padding: "10px 12px" }}
            onClick={() => setShowMoney((v) => !v)}
            aria-expanded={showMoney}
          >
            <span className="col" style={{ gap: 2, alignItems: "center" }}>
              <span className="row" style={{ gap: 6 }}>
                <Icon name="wallet" size={15} /> For money
              </span>
              <span style={{ fontSize: 10.5, fontWeight: 500, opacity: 0.65 }}>Stake $0.25–1 · winner takes 92%</span>
            </span>
          </button>
        </div>
      </div>

      {/* stake-a-match — revealed only when asked for, with its help alongside.
          Self verification never blocks the stake (that would be exactly the
          funnel friction we designed away): playing for money is open, and the
          verify prompt sits ABOVE the panel only to unlock *league prize
          eligibility*. The real payout gate lives server-side. */}
      {showMoney && (
        <div className="stack animate-in" style={{ gap: 10 }} ref={moneyRef}>
          {staking ? (
            <>
              {SELF_CONFIGURED && !verified && (
                <PersonhoodVerify account={address} onVerified={() => setVerified(true)} />
              )}
              <MatchActions wallet={wallet} account={address} cfg={cfg} />
            </>
          ) : hasProvider && cfg ? (
            // a desktop wallet (MetaMask & co) is installed but hasn't
            // approved the site — an explicit connect makes money play
            // testable outside MiniPay
            <div className="card stack" style={{ gap: 10, alignItems: "center", textAlign: "center" }}>
              <span className="muted">A wallet is installed — connect it to play for money.</span>
              <button
                className="btn block"
                onClick={async () => {
                  const provider = getInjectedProvider();
                  if (!provider) return;
                  try {
                    const c = await connect(provider, cfg.chainId, { interactive: true });
                    setWallet(c.wallet as unknown as WriteClient);
                    setAddress(c.address);
                  } catch {
                    /* user declined */
                  }
                }}
              >
                <Icon name="wallet" size={17} /> Connect wallet
              </button>
            </div>
          ) : (
            <div className="card muted">Open in MiniPay to play for money.</div>
          )}
          <HowItWorks />
        </div>
      )}

      {/* daily habits — two slim rows, not a wall */}
      <div className="stack" style={{ gap: 8 }}>
        <NavRow
          href="/daily"
          icon="bolt"
          tone={didDaily ? "neutral" : "gold"}
          title="Daily puzzle"
          sub={didDaily ? `Solved · ${streak}-day streak 🔥` : streak > 0 ? `Keep your ${streak}-day streak 🔥` : "Solve one capture a day"}
        />
        {showLearnHint ? (
          <NavRow href="/learn" icon="info" tone="gold" title="How to play" sub="New here? Learn in 30 seconds" />
        ) : (
          <NavRow href="/play" icon="play" title="Practice vs AI" sub="Pick your level — always free" />
        )}
      </div>

      <div className="spacer" />

      {/* help, demoted to footer links — reference, not destinations.
          Whichever of learn/practice already has a row above isn't repeated. */}
      <div className="row" style={{ justifyContent: "center", gap: 14, paddingBottom: 4 }}>
        {showLearnHint ? (
          <Link href="/play" className="faint" style={{ fontSize: 12.5 }}>
            Practice vs AI
          </Link>
        ) : (
          <Link href="/learn" className="faint" style={{ fontSize: 12.5 }}>
            How to play
          </Link>
        )}
        <button className="faint" style={{ fontSize: 12.5, background: "none", border: "none", cursor: "pointer" }} onClick={() => setShowMoney(true)}>
          How money works
        </button>
      </div>
    </main>
  );
}
