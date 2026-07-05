"use client";

import { useEffect } from "react";
import { Icon } from "./Icon.js";
import { sfx } from "../lib/sound.js";

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
  stats,
  saveHref,
  rematchHref,
  onRematch,
  rematchState = "idle",
  onPlayAgain,
  onShare,
}: {
  result: 0 | 1 | 2; // 0 = you win, 1 = you lose, 2 = draw (viewer perspective)
  /** Optional human-readable winnings string, e.g. "1.95 USDC". */
  payout?: string;
  /** End-of-game stats for the result card. */
  stats?: { mine: number; opp: number; moves?: number };
  /** When set (cash win), offer to grow a share of the winnings in the League. */
  saveHref?: string;
  /** Fallback one-tap rematch link (practice / no live opponent socket). */
  rematchHref?: string;
  /** Interactive same-opponent rematch: called to offer OR to accept an
   *  incoming offer. When provided, it supersedes rematchHref. */
  onRematch?: () => void;
  /** Drives the rematch button's label/state. */
  rematchState?: "idle" | "offered" | "incoming" | "declined";
  onPlayAgain: () => void;
  onShare?: () => void;
}) {
  const win = result === 0;
  const draw = result === 2;

  useEffect(() => {
    haptic(win ? [18, 50, 18, 50, 40] : draw ? [20, 40] : 30);
    sfx(win ? "win" : draw ? "draw" : "lose");
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

      <div
        style={{
          display: "grid",
          placeItems: "center",
          width: 92,
          height: 92,
          borderRadius: "50%",
          color: win ? "var(--gold)" : draw ? "var(--text)" : "var(--muted)",
          background: win ? "var(--gold-soft)" : "rgba(255,255,255,0.05)",
          boxShadow: `inset 0 0 0 1.5px ${win ? "rgba(246,200,99,0.4)" : "var(--line)"}`,
        }}
      >
        <Icon name={win ? "trophy" : draw ? "versus" : "seed"} size={44} stroke={1.6} />
      </div>
      <div className="display" style={{ color: win ? "var(--gold)" : "var(--text)", textAlign: "center" }}>
        {title}
      </div>
      <div className="muted" style={{ textAlign: "center" }}>
        {sub}
      </div>

      {stats && (
        <div
          className="card flat"
          style={{ display: "flex", width: "100%", maxWidth: 280, padding: "12px 8px", marginTop: 4 }}
        >
          {[
            { label: "You", value: stats.mine, tone: "var(--accent)" },
            { label: "Opponent", value: stats.opp, tone: "var(--text)" },
            ...(stats.moves != null ? [{ label: "Moves", value: stats.moves, tone: "var(--muted)" }] : []),
          ].map((s) => (
            <div key={s.label} className="col" style={{ flex: 1, alignItems: "center", gap: 2 }}>
              <span className="title score" style={{ color: s.tone, fontSize: 22 }}>
                {s.value}
              </span>
              <span className="faint">{s.label}</span>
            </div>
          ))}
        </div>
      )}

      <div className="stack" style={{ width: "100%", maxWidth: 260, marginTop: 8 }}>
        {/* Interactive same-opponent rematch (preferred): offer → accept →
            straight into a new game with the SAME player, no lobby detour. */}
        {onRematch && rematchState === "idle" && (
          <button className="btn block" onClick={onRematch}>
            <Icon name="versus" size={17} /> Rematch — same opponent
          </button>
        )}
        {onRematch && rematchState === "offered" && (
          <button className="btn block" disabled>
            <span className="dot pulse" /> Waiting for opponent to accept…
          </button>
        )}
        {onRematch && rematchState === "incoming" && (
          <button className="btn block" onClick={onRematch} style={{ animation: "pulse 1.2s ease-in-out infinite" }}>
            <Icon name="versus" size={17} /> Opponent wants a rematch — accept
          </button>
        )}
        {onRematch && rematchState === "declined" && (
          <button className="btn block" onClick={onRematch}>
            <Icon name="versus" size={17} /> Opponent left — offer a rematch
          </button>
        )}
        {/* Fallback link (e.g. practice) when no live opponent socket exists. */}
        {!onRematch && rematchHref && (
          <a className="btn block" href={rematchHref}>
            <Icon name="versus" size={17} /> Rematch — same stake
          </a>
        )}
        {saveHref && (
          <a className="btn block" href={saveHref} style={{ background: "linear-gradient(180deg, #f7d27a, var(--gold))" }}>
            <Icon name="trophy" size={17} /> You scored league points — see the race
          </a>
        )}
        <button className={`btn ${saveHref || rematchHref ? "secondary" : ""} block`} onClick={onPlayAgain}>
          <Icon name="play" size={17} /> Play again
        </button>
        {onShare && (
          <button className="btn secondary block" onClick={onShare}>
            <Icon name="share" size={17} /> Share result
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
