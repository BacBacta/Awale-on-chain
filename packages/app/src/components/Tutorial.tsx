"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { initialState, applyMove, type GameState } from "../../../engine/src/awale.js";
import { Board } from "./Board.js";

// Interactive "how to play" — teaches sowing then capture by doing. Each
// interactive step only lets the learner tap the highlighted house; the board
// animates the result.

function makeState(pits: number[], turn: 0 | 1 = 0, store0 = 0, store1 = 0): GameState {
  return { pits: pits.slice(), store0, store1, turn, over: false, winner: 0 };
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
}

const STEPS: Step[] = [
  {
    title: "The goal",
    body: "Awalé is a two-player game. Each player sows seeds around the board and tries to capture as many as possible into their store. Whoever holds the most seeds at the end wins.",
    success: "",
  },
  {
    title: "Sowing",
    body: "Tap the highlighted house. Its seeds are scooped up and dropped one by one into the following houses, going counter-clockwise.",
    board: initialState(),
    target: 2,
    success: "That's sowing: each seed lands in the next house. It's the heart of the game.",
  },
  {
    title: "Capturing",
    body: "If your last seed lands in one of your opponent's houses (the top row) and brings it to 2 or 3 seeds, you capture them! Tap the highlighted house.",
    // bottom row: only house 5 has a seed; opponent pit 6 has 1 → playing 5 lands in 6 making it 2 → capture
    board: makeState([0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0]),
    target: 5,
    success: "Capture! The seeds go into your store (on the right). That's how you score.",
  },
  {
    title: "Playing for money",
    body: "Practice and the daily puzzle are always free. When you're ready, you and an opponent can each put the same amount into the pot — say $1. The winner takes the pot, minus a small house fee shown before you start.",
    success: "",
  },
  {
    title: "Ready to play",
    body: "That's all you need to get started. You'll pick up the finer points as you play. Have a great game!",
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

      <div className="stack" style={{ flex: 1, justifyContent: "center", gap: 16 }}>
        <div className="card stack animate-in" style={{ gap: 8 }} key={step}>
          <span className="h2">{s.title}</span>
          <span className="muted">{solved && s.success ? s.success : s.body}</span>
        </div>

        {board && <Board state={board} onPlay={onPlay} playable={playable} />}

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
