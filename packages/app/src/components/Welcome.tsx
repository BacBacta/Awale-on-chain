"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { HeroBoard } from "./HeroBoard.js";
import { Icon } from "./Icon.js";
import { WINNER_PCT, RACE_SHARE_PCT } from "../lib/money.js";

// One-time first-run welcome. Shown until the player dismisses it (localStorage).
// Deliberately ONE screen (multi-step carousels bleed users in a webview) — but
// that one screen now sells the three concrete promises, numbers from money.ts:
// free in 30s, winner paid instantly, fees flow back to players via the race.
const KEY = "awale_welcomed";

function Promise_({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <span className="row" style={{ gap: 10, alignItems: "center", width: "100%" }}>
      <span style={{ fontSize: 17, width: 24, textAlign: "center" }}>{icon}</span>
      <span className="muted" style={{ flex: 1, fontSize: 13, lineHeight: 1.4, textAlign: "left" }}>
        {children}
      </span>
    </span>
  );
}

export function Welcome() {
  const [show, setShow] = useState(false);
  const router = useRouter();

  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) !== "1") setShow(true);
    } catch {
      /* ignore */
    }
  }, []);

  function dismiss(then?: () => void) {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* ignore */
    }
    setShow(false);
    then?.();
  }

  if (!show) return null;

  return (
    <div
      role="dialog"
      aria-label="Welcome to Awalé"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        padding: 28,
        background: "radial-gradient(120% 80% at 50% 20%, rgba(20,18,14,0.96), rgba(6,5,4,0.99))",
        backdropFilter: "blur(6px)",
        animation: "fade-up 360ms cubic-bezier(0.16,1,0.3,1) both",
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.35,
          filter: "blur(4px)",
          display: "grid",
          placeItems: "center",
          WebkitMaskImage: "radial-gradient(90% 60% at 50% 35%, #000 30%, transparent 70%)",
          maskImage: "radial-gradient(90% 60% at 50% 35%, #000 30%, transparent 70%)",
        }}
      >
        <div style={{ width: "150%" }}>
          <HeroBoard />
        </div>
      </div>

      <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, maxWidth: 320, width: "100%" }}>
        <span className="chip gold">One of the oldest games on Earth</span>
        <span className="brand" style={{ fontSize: 46, textShadow: "0 2px 20px rgba(0,0,0,0.6)" }}>
          Awalé
        </span>
        <span className="muted" style={{ textAlign: "center", lineHeight: 1.5 }}>
          Sow seeds, capture, win the pot — every match climbs your rank.
        </span>

        <div
          className="card flat stack"
          style={{ width: "100%", gap: 10, padding: "12px 14px", background: "rgba(255,255,255,0.04)" }}
        >
          <Promise_ icon="⚡">Learn the rules in a minute — free games, forever</Promise_>
          <Promise_ icon="💰">
            Win money: <b style={{ color: "var(--text)" }}>{WINNER_PCT} of the pot</b>, paid straight to your wallet
          </Promise_>
          <Promise_ icon="🏁">
            <b style={{ color: "var(--text)" }}>{RACE_SHARE_PCT} of every fee returns to players</b> — the weekly pot
            splits each Monday
          </Promise_>
        </div>

        <div className="stack" style={{ width: "100%", marginTop: 2, gap: 10 }}>
          <button className="btn block" onClick={() => dismiss(() => router.push("/learn"))}>
            <Icon name="info" size={17} /> Learn to play · 30 sec
          </button>
          <button
            className="btn ghost block"
            onClick={() => {
              // Skipping is an explicit "I know the game" — don't nag with learn hints later.
              try {
                localStorage.setItem("awale_tutorial_seen", "1");
              } catch {
                /* ignore */
              }
              dismiss();
            }}
          >
            I already know Awalé
          </button>
        </div>
      </div>
    </div>
  );
}
