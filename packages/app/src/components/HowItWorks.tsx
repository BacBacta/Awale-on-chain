"use client";

import { useState } from "react";
import { Icon } from "./Icon.js";
import { WINNER_PCT, RACE_SHARE_PCT } from "../lib/money.js";

// Plain-language answer to "how do I win money here?" — a quiet list-row that
// expands in place. No crypto vocabulary: pot, dollars, house fee. Leads with
// the PLAYER BENEFITS (fee flows back via the race pot, instant payout, fair
// matching) — the numbers come from money.ts so they can never disagree with
// the deployed rake or the server's pool share.
const STEPS = [
  "You and your opponent each put the same amount in the pot — say $1.",
  `Play the match. The winner takes ${WINNER_PCT} of the pot, paid straight to your wallet — the small house fee is shown before you start.`,
  `${RACE_SHARE_PCT} of every house fee goes into the Weekly race pot and is shared back to players every Monday — just playing money games earns you a piece.`,
  "Money matches are skill-matched — you never face a far stronger player for money.",
  "Practice and the daily puzzle are always free · cancel an unjoined match anytime for a full refund.",
  "18+ · play responsibly: only stake what you can afford to lose.",
];

export function HowItWorks() {
  const [open, setOpen] = useState(false);

  return (
    <div className="stack" style={{ gap: 8 }}>
      <button
        className="list-row"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ font: "inherit" }}
      >
        <span className="lead neutral">
          <Icon name="wallet" size={19} />
        </span>
        <span className="col" style={{ flex: 1, gap: 1 }}>
          <span style={{ fontWeight: 700, fontSize: 14.5 }}>How you win money</span>
          <span className="faint">Winner takes {WINNER_PCT} · {RACE_SHARE_PCT} of fees return to players</span>
        </span>
        <Icon name="arrowRight" size={16} style={{ color: "var(--faint)", transform: open ? "rotate(90deg)" : "none", transition: "transform 200ms var(--ease-out)" }} />
      </button>

      {open && (
        <div className="card flat stack animate-in" style={{ gap: 10, padding: "12px 14px" }}>
          {STEPS.map((s, i) => (
            <span key={i} className="row" style={{ gap: 10, alignItems: "flex-start" }}>
              <span className="chip gold" style={{ minWidth: 22, justifyContent: "center", padding: "2px 0" }}>
                {i + 1}
              </span>
              <span className="muted" style={{ flex: 1, lineHeight: 1.45 }}>
                {s}
              </span>
            </span>
          ))}
          <a href="/guide" className="faint" style={{ alignSelf: "center", fontSize: 12.5 }}>
            The full guide — game, money, the race, safety →
          </a>
        </div>
      )}
    </div>
  );
}
