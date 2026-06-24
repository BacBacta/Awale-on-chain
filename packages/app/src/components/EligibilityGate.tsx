"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "./Icon.js";
import { acknowledgeEligibility } from "../lib/compliance.js";

// Shown in place of the real-money actions until the player attests eligibility.
// Awalé is a pure-skill game; players must be 18+ and legally allowed to play
// skill games for money in their location.
export function EligibilityGate({ onAccept }: { onAccept: () => void }) {
  const [checked, setChecked] = useState(false);

  function accept() {
    if (!checked) return;
    acknowledgeEligibility();
    onAccept();
  }

  return (
    <div className="card stack animate-in" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10, alignItems: "center" }}>
        <span className="lead gold">
          <Icon name="info" size={18} />
        </span>
        <span className="h2">Before you play for stablecoin</span>
      </div>
      <span className="muted" style={{ lineHeight: 1.5 }}>
        Awalé is a <b>game of pure skill</b> — no chance, the better player wins. Cash matches put your
        stablecoin at stake. Please confirm you&apos;re eligible.
      </span>

      <label className="row" style={{ gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          style={{ marginTop: 3, width: 18, height: 18, accentColor: "var(--accent)" }}
        />
        <span className="muted" style={{ lineHeight: 1.45 }}>
          I am <b>18 or older</b> and playing skill games for money is <b>legal where I live</b>. I play
          responsibly and only stake what I can afford to lose.
        </span>
      </label>

      <button className="btn block" onClick={accept} disabled={!checked}>
        Confirm & continue
      </button>

      <span className="faint" style={{ textAlign: "center" }}>
        By continuing you agree to our{" "}
        <Link href="/legal" style={{ color: "var(--muted)" }}>
          Terms &amp; Privacy
        </Link>
        .
      </span>
    </div>
  );
}
