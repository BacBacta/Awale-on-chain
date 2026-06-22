"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { legalMovesMask, applyMove, type GameState } from "../../../engine/src/awale.js";
import { Board } from "../../src/components/Board.js";
import { Icon } from "../../src/components/Icon.js";
import { dailyPuzzle, captureGain, recordSolved, streakCount, solvedToday, todayKey } from "../../src/lib/daily.js";
import { sfx } from "../../src/lib/sound.js";

function legalHouses(s: GameState): number[] {
  const m = legalMovesMask(s);
  const out: number[] = [];
  for (let h = 0; h < 6; h++) if (m & (1 << h)) out.push(h);
  return out;
}

export default function Daily() {
  const puzzle = useMemo(() => dailyPuzzle(), []);
  const [board, setBoard] = useState<GameState>(puzzle.state);
  const [done, setDone] = useState(false);
  const [streak, setStreak] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    setStreak(streakCount());
    if (solvedToday()) {
      setDone(true);
      setFeedback("You've already solved today's puzzle.");
    }
  }, []);

  function onPlay(h: number) {
    if (done) return;
    const correct = puzzle.bestGain > 0 ? captureGain(puzzle.state, h) === puzzle.bestGain : puzzle.solution.includes(h);
    if (correct) {
      setBoard(applyMove(puzzle.state, h)); // animate the capture
      setDone(true);
      sfx("win");
      setStreak(recordSolved());
      setFeedback(null);
    } else {
      const g = puzzle.bestGain > 0 ? captureGain(puzzle.state, h) : 0;
      sfx("lose");
      setFeedback(puzzle.bestGain > 0 ? `That captures ${g}. You can do better — try again.` : "Not the strongest move — try again.");
    }
  }

  const playable = done ? [] : legalHouses(board);

  return (
    <main className="pad stack" style={{ flex: 1, gap: 14 }}>
      <div className="row">
        <span className="title">Daily puzzle</span>
        <span className="chip gold">
          <Icon name="bolt" size={13} /> {streak}-day streak
        </span>
      </div>

      <div className="card" style={{ padding: "12px 14px" }}>
        <span className="muted">{done ? "Solved ✓ — come back tomorrow for a new one." : puzzle.goal}</span>
      </div>

      <Board state={board} onPlay={onPlay} playable={playable} silent={done} />

      {feedback && (
        <div className={`chip ${done ? "positive" : "danger"}`} style={{ alignSelf: "center", padding: "8px 12px" }}>
          {feedback}
        </div>
      )}

      {done ? (
        <div className="stack" style={{ gap: 10 }}>
          <div className="card row">
            <span className="muted">Streak</span>
            <span className="title score" style={{ color: "var(--gold)" }}>
              {streak} 🔥
            </span>
          </div>
          <Link className="btn block" href="/">
            <Icon name="play" size={17} /> Play a game
          </Link>
        </div>
      ) : (
        <span className="faint" style={{ textAlign: "center" }}>
          {todayKey()} · one new puzzle every day
        </span>
      )}

      <div className="spacer" />
    </main>
  );
}
