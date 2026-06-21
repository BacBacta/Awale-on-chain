"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { initialState, applyMove, type GameState } from "../../../engine/src/awale.js";
import { Board } from "./Board.js";

// Interactive "how to play" — teaches sowing then capture by doing, in French
// (the novice audience this is built for). Each interactive step only lets the
// learner tap the highlighted house; the board animates the result.

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
    title: "Le but du jeu",
    body: "L'Awalé se joue à deux. Chacun sème des graines autour du plateau et tente d'en capturer le plus possible dans son grenier. Celui qui a le plus de graines à la fin gagne.",
    success: "",
  },
  {
    title: "Semer",
    body: "Touche la case surlignée. Ses graines sont ramassées puis déposées une à une dans les cases suivantes, dans le sens anti-horaire.",
    board: initialState(),
    target: 2,
    success: "Voilà le semis : chaque graine tombe dans la case suivante. C'est le cœur du jeu.",
  },
  {
    title: "Capturer",
    body: "Si ta dernière graine tombe dans une case de l'adversaire (la rangée du haut) et la porte à 2 ou 3 graines, tu captures ces graines ! Touche la case surlignée.",
    // bottom row: only house 5 has a seed; opponent pit 6 has 1 → playing 5 lands in 6 making it 2 → capture
    board: makeState([0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0]),
    target: 5,
    success: "Capture ! Les graines partent dans ton grenier (à droite). C'est comme ça qu'on marque.",
  },
  {
    title: "Prêt·e à jouer",
    body: "C'est tout ce qu'il faut savoir pour commencer. Tu apprendras les subtilités en jouant. Bonne partie !",
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
          ← Retour
        </Link>
        <span className="chip">
          Étape {step + 1}/{STEPS.length}
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
            Touche la case surlignée
          </span>
        )}
      </div>

      {/* advance: text steps and solved interactive steps */}
      {(s.target == null || solved) &&
        (isLast ? (
          <Link className="btn block" href="/play">
            Jouer une démo
          </Link>
        ) : (
          <button className="btn block" onClick={() => setStep((n) => n + 1)}>
            Continuer
          </button>
        ))}
    </main>
  );
}
