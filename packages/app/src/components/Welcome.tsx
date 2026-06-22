"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { HeroBoard } from "./HeroBoard.js";
import { Icon } from "./Icon.js";

// One-time first-run welcome. Shown until the player dismisses it (localStorage).
const KEY = "awale_welcomed";

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
        background: "var(--bg)",
        animation: "fade-up 360ms var(--ease-out) both",
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.12,
          display: "grid",
          placeItems: "center",
          WebkitMaskImage: "radial-gradient(80% 55% at 50% 38%, #000 20%, transparent 72%)",
          maskImage: "radial-gradient(80% 55% at 50% 38%, #000 20%, transparent 72%)",
        }}
      >
        <div style={{ width: "150%" }}>
          <HeroBoard />
        </div>
      </div>

      <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, maxWidth: 300 }}>
        <span className="chip">One of the oldest games on Earth</span>
        <span className="brand" style={{ fontSize: 44 }}>
          Awalé
        </span>
        <span className="muted" style={{ textAlign: "center", lineHeight: 1.5 }}>
          Sow seeds, capture, and win the pot. A timeless strategy game — now for stablecoin stakes, non-custodial.
        </span>

        <div className="stack" style={{ width: "100%", marginTop: 6, gap: 10 }}>
          <button className="btn block" onClick={() => dismiss(() => router.push("/learn"))}>
            <Icon name="info" size={17} /> Learn to play
          </button>
          <button className="btn secondary block" onClick={() => dismiss()}>
            Start playing
          </button>
        </div>
      </div>
    </div>
  );
}
