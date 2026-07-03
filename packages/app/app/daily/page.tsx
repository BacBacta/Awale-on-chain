"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { legalMovesMask, applyMove, type GameState } from "../../../engine/src/awale.js";
import { Board } from "../../src/components/Board.js";
import { Icon } from "../../src/components/Icon.js";
import { dailyPuzzle, captureGain, recordSolved, streakCount, solvedToday, todayKey } from "../../src/lib/daily.js";
import { getProfile, reportDailySolve } from "../../src/lib/profile.js";
import { pushSupported, registerPush } from "../../src/lib/push.js";
import { getInjectedProvider, connect } from "../../src/lib/minipay.js";
import { escrowConfig } from "../../src/lib/escrow.js";
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
  const [remind, setRemind] = useState<"off" | "offered" | "on">("off");
  const account = useRef<Address | null>(null);

  useEffect(() => {
    setStreak(streakCount());
    // the header line already says "Solved ✓ — come back tomorrow"; a second
    // banner repeating it below the board was noise, not reassurance
    if (solvedToday()) setDone(true);
    // Best-effort wallet identity: with it the streak lives server-side and
    // survives reinstalls/device changes; without it, localStorage still works.
    const provider = getInjectedProvider();
    if (!provider) return;
    connect(provider, escrowConfig()?.chainId)
      .then(async ({ address }) => {
        account.current = address;
        const p = await getProfile(address);
        // the server may know a longer (or the only surviving) streak
        if (p && p.streak > 0) setStreak((s) => Math.max(s, p.streak));
        if (pushSupported()) setRemind("offered");
      })
      .catch(() => {});
  }, []);

  function onPlay(h: number) {
    if (done) return;
    const correct = puzzle.bestGain > 0 ? captureGain(puzzle.state, h) === puzzle.bestGain : puzzle.solution.includes(h);
    if (correct) {
      setBoard(applyMove(puzzle.state, h)); // animate the capture
      setDone(true);
      sfx("win");
      const local = recordSolved();
      setStreak(local);
      setFeedback(null);
      // server is the source of truth; the local count rides along once so a
      // pre-profile streak isn't lost the day this ships
      if (account.current) {
        void reportDailySolve(account.current, { count: local, lastDone: todayKey() }).then((s) => {
          if (s !== null) setStreak(s);
        });
      }
    } else {
      const g = puzzle.bestGain > 0 ? captureGain(puzzle.state, h) : 0;
      sfx("lose");
      setFeedback(puzzle.bestGain > 0 ? `That captures ${g}. You can do better — try again.` : "Not the strongest move — try again.");
    }
  }

  async function enableReminders() {
    if (!account.current) return;
    const ok = await registerPush(account.current);
    setRemind(ok ? "on" : "offered");
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
          {remind === "offered" && (
            <button className="btn secondary block" onClick={enableReminders}>
              🔔 Remind me before my streak breaks
            </button>
          )}
          {remind === "on" && (
            <div className="chip positive" style={{ alignSelf: "center" }}>
              Reminders on — we&apos;ll nudge you if a day is about to slip
            </div>
          )}
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
