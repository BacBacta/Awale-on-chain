"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { initialState, applyMove, type GameState } from "../../../engine/src/awale.js";
import { Board } from "./Board.js";
import { track } from "../lib/analytics.js";

// Interactive "how to play" — teaches sowing then capture by doing. Each
// interactive step only lets the learner tap the highlighted house; the board
// animates the result.

function makeState(pits: number[], turn: 0 | 1 = 0, store0 = 0, store1 = 0): GameState {
  return { pits: pits.slice(), store0, store1, turn, over: false, winner: 0, noCaptureCount: 0 };
}

interface Step {
  title: string;
  body: string;
  /** Interactive board to show; omit for a text-only step. */
  board?: GameState;
  /** House (0..5) the learner must tap to advance. */
  target?: number;
  /** Shown once the move is played. */
  success: string;
  /** A fine-point rule callout shown under the body (optional). */
  note?: string;
}

const STEPS: Step[] = [
  {
    title: "The goal",
    body: "Awalé is played with 48 seeds across 12 houses. On your turn you sow one house's seeds around the board. Bank more than half — 25 seeds — into your store and you win.",
    success: "",
  },
  {
    title: "Sowing",
    body: "Tap the glowing house. Its seeds are scooped up and dropped one by one into each house that follows, going counter-clockwise — right along your row, then up and around.",
    board: initialState(),
    target: 2,
    success: "That's a sow: every seed moves one house forward. You empty a house to fill the next ones.",
    note: "A house holding 12+ seeds laps the whole board and skips over its own starting house.",
  },
  {
    title: "Capturing",
    body: "The scoring move: if your LAST seed lands in one of your opponent's houses (the top row) and leaves it on exactly 2 or 3 seeds, you scoop those into your store. Tap the glowing house.",
    // bottom row: only house 5 has a seed; opponent pit 6 has 1 → playing 5 lands in 6 making it 2 → capture
    board: makeState([0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0]),
    target: 5,
    success: "Capture! Banked in your store on the right. Captures happen only on your opponent's row, only on a 2 or a 3.",
  },
  {
    title: "Chain capture",
    body: "It gets better: after a capture, if the house just BEFORE it (still on your opponent's row) also holds 2 or 3, you take that one too — and keep walking back while the run lasts. Tap the glowing house.",
    // house 5 has 2 → sows pit6 (1→2) and pit7 (2→3); last on pit7=3 captures, walks back to pit6=2 → 5 seeds
    board: makeState([0, 0, 0, 0, 0, 2, 1, 2, 1, 0, 0, 0]),
    target: 5,
    success: "Five seeds in one move — your last seed made a 3, the house before it a 2, both captured. Chains are how big swings happen.",
    note: "The one limit: a move that would capture ALL your opponent's seeds captures nothing — you can't wipe them out in a single stroke.",
  },
  {
    title: "Feed your opponent",
    body: "If your opponent has no seeds, you MUST play a move that reaches their side and gives them some. Houses that can't do that are greyed out — here only the glowing one is legal. Tap it.",
    // opponent row empty; house 3 (1 seed) stays on your side (illegal), house 5 (2) reaches → only legal move
    board: makeState([0, 0, 0, 1, 0, 2, 0, 0, 0, 0, 0, 0]),
    target: 5,
    success: "Your opponent has seeds to play again. If NO move can feed them, the game ends and each side keeps the seeds on its own row.",
  },
  {
    title: "How a game ends",
    body: "A game ends the instant someone banks 25 seeds — they win. It also ends if the seeds just cycle with no captures, or a player can't move: each side then collects its own row, and the higher total wins (level is a draw).",
    success: "",
  },
  {
    title: "Playing for money",
    body: "Practice and the daily puzzle are always free. In a money game, you and your opponent each stake the same amount into one pot — say $1. Win and you take the pot minus a small fee (shown before you start). A draw returns both stakes in full, with no fee.",
    success: "",
    note: "One rule to remember: don't abandon a money game — if you quit, your opponent can claim the whole pot.",
  },
  {
    title: "Ready to play",
    body: "You've got it: sow, capture on 2 or 3, chain, feed, race to 25. Everything else is strategy you'll sharpen every match. Have a great game!",
    success: "",
  },
];

export function Tutorial() {
  const [step, setStep] = useState(0);
  const [board, setBoard] = useState<GameState | null>(null);
  const [solved, setSolved] = useState(false);

  const s = STEPS[step];
  const isLast = step === STEPS.length - 1;

  useEffect(() => {
    setBoard(s.board ? makeState(s.board.pits, s.board.turn as 0 | 1, s.board.store0, s.board.store1) : null);
    setSolved(false);
    if (isLast) track("tutorial_done");
    try {
      localStorage.setItem("awale_tutorial_seen", "1");
    } catch {
      /* ignore */
    }
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const playable = useMemo(() => (s.target != null && !solved ? [s.target] : []), [s.target, solved]);

  function onPlay(house: number) {
    if (!board || s.target == null || house !== s.target) return;
    setBoard(applyMove(board, house));
    setSolved(true);
  }

  return (
    <main className="pad stack" style={{ flex: 1, gap: 16, position: "relative" }}>
      <div className="row">
        <Link className="btn ghost" href="/" style={{ padding: "6px 10px" }}>
          ← Back
        </Link>
        <span className="chip">
          Step {step + 1}/{STEPS.length}
        </span>
      </div>

      {/* one layout for every step — card up top, board beneath. Text-only
          steps keep a (non-playable) board so the screen never collapses into
          a lone paragraph floating in darkness. */}
      <div className="stack" style={{ flex: 1, gap: 16 }}>
        <div className="card stack animate-in" style={{ gap: 8 }} key={step}>
          <span className="h2">{s.title}</span>
          <span className="muted">{solved && s.success ? s.success : s.body}</span>
          {s.note && (
            <span className="faint" style={{ fontSize: 12.5, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
              💡 {s.note}
            </span>
          )}
        </div>

        {board ? (
          <Board state={board} onPlay={onPlay} playable={playable} suggest={playable[0] ?? null} />
        ) : (
          <div style={{ opacity: 0.55, pointerEvents: "none" }} aria-hidden>
            <Board state={initialState()} onPlay={() => {}} playable={[]} />
          </div>
        )}

        {s.target != null && !solved && (
          <span className="chip gold" style={{ alignSelf: "center" }}>
            <span className="dot pulse" />
            Tap the highlighted house
          </span>
        )}
      </div>

      {/* advance: text steps and solved interactive steps */}
      {(s.target == null || solved) &&
        (isLast ? (
          <Link className="btn block" href="/play">
            Play your first game — free
          </Link>
        ) : (
          <button className="btn block" onClick={() => setStep((n) => n + 1)}>
            Continue
          </button>
        ))}
    </main>
  );
}
