"use client";

import { useEffect } from "react";

// End-of-game celebration moment. Win/lose/draw each get a distinct treatment.
// TODO(premium): swap the CSS confetti for a Lottie burst — lottie-react is
// already a dependency; drop a win.json into /public and render <Lottie/> here.

const CONFETTI = Array.from({ length: 28 }, (_, i) => i);
const COLORS = ["#3ddc6f", "#f5c451", "#fbe6b0", "#ff8f5c", "#7ad6ff"];

function haptic(p: number | number[]) {
  try {
    navigator.vibrate?.(p);
  } catch {
    /* no-op */
  }
}

export function GameOverlay({
  result,
  payout,
  onPlayAgain,
  onShare,
}: {
  result: 0 | 1 | 2; // 0 = you win, 1 = you lose, 2 = draw (viewer perspective)
  /** Optional human-readable winnings string, e.g. "1.95 USDC". */
  payout?: string;
  onPlayAgain: () => void;
  onShare?: () => void;
}) {
  const win = result === 0;
  const draw = result === 2;

  useEffect(() => {
    haptic(win ? [18, 50, 18, 50, 40] : draw ? [20, 40] : 30);
  }, [win, draw]);

  const title = win ? "You win!" : draw ? "It's a draw" : "You lost";
  const sub = win
    ? payout
      ? `You take the pot · +${payout}`
      : "Winner takes the pot"
    : draw
      ? "Stakes are returned"
      : "Better luck next round";

  return (
    <div
      role="dialog"
      aria-label={title}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 24,
        background: "radial-gradient(120% 80% at 50% 30%, rgba(20,26,19,0.92), rgba(7,9,6,0.97))",
        backdropFilter: "blur(4px)",
        zIndex: 10,
        animation: "fade-up 320ms cubic-bezier(0.16,1,0.3,1) both",
      }}
    >
      {win && (
        <div aria-hidden style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
          {CONFETTI.map((i) => {
            const left = (i * 37) % 100;
            const delay = (i % 7) * 90;
            const dur = 1400 + (i % 5) * 260;
            return (
              <span
                key={i}
                style={{
                  position: "absolute",
                  top: "-8%",
                  left: `${left}%`,
                  width: 8,
                  height: 12,
                  borderRadius: 2,
                  background: COLORS[i % COLORS.length],
                  opacity: 0.9,
                  animation: `confetti-fall ${dur}ms linear ${delay}ms infinite`,
                }}
              />
            );
          })}
        </div>
      )}

      <div style={{ fontSize: 56, lineHeight: 1 }}>{win ? "🏆" : draw ? "🤝" : "😔"}</div>
      <div className="display" style={{ color: win ? "var(--gold)" : "var(--text)", textAlign: "center" }}>
        {title}
      </div>
      <div className="muted" style={{ textAlign: "center" }}>
        {sub}
      </div>

      <div className="stack" style={{ width: "100%", maxWidth: 260, marginTop: 8 }}>
        <button className="btn block" onClick={onPlayAgain}>
          Play again
        </button>
        {onShare && (
          <button className="btn secondary block" onClick={onShare}>
            Share result
          </button>
        )}
      </div>

      <style>{`@keyframes confetti-fall {
        0% { transform: translateY(0) rotate(0deg); opacity: 0.95; }
        100% { transform: translateY(${100}vh) rotate(540deg); opacity: 0.4; }
      }`}</style>
    </div>
  );
}
