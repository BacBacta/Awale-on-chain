"use client";

import { useState } from "react";
import { Icon } from "./Icon.js";

// Plain-language answer to "how do I win money here?" — a quiet list-row that
// expands in place. No crypto vocabulary: pot, dollars, house fee.
const STEPS = [
  "You and your opponent each put the same amount in the pot — say $1.",
  "Play the match. The winner takes the pot, minus a small house fee (shown before you start).",
  "Practice and the daily puzzle are always free.",
  "You can cancel an unjoined match anytime — your stake comes back in full.",
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
          <span className="faint">Free to play · winner takes the pot</span>
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
        </div>
      )}
    </div>
  );
}
