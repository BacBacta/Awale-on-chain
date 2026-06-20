"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { initialState, applyMove, legalMovesMask, type GameState } from "../../../engine/src/awale.js";
import { Board, moveDurationMs } from "./Board.js";
import { GameOverlay } from "./GameOverlay.js";
import { PlayerPanel } from "./PlayerPanel.js";
import { createSessionKey, signMove, type SessionKey } from "../lib/session.js";

// Demo context — in a real match these come from the on-chain join events.
const DEMO_CTX = { chainId: 31337n, verifier: "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3" as const };
const DEMO_MATCH_ID = 1n;

function legalHouses(s: GameState): number[] {
  const mask = legalMovesMask(s);
  const out: number[] = [];
  for (let h = 0; h < 6; h++) if (mask & (1 << h)) out.push(h);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Self-contained game vs a trivial bot — no server or chain needed. */
export function LocalDemo() {
  const [state, setState] = useState<GameState>(() => initialState());
  const [ply, setPly] = useState(0);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);

  const sessions = useMemo<[SessionKey, SessionKey]>(() => [createSessionKey(), createSessionKey()], []);

  useEffect(() => {
    if (state.over) {
      const t = setTimeout(() => setShowOverlay(true), 600);
      return () => clearTimeout(t);
    }
  }, [state.over]);

  const playable = state.turn === 0 && !state.over && !busy ? legalHouses(state) : [];
  const result: 0 | 1 | 2 | null = state.over ? (state.winner as 0 | 1 | 2) : null;

  // seeds in the house about to be played (drives how long the board animates)
  function seedsOf(s: GameState, absIdx: number): number {
    return s.pits[absIdx];
  }

  async function play(house: number) {
    if (busy || state.over || state.turn !== 0) return;
    setBusy(true);
    try {
      await signMove(sessions[0], DEMO_MATCH_ID, BigInt(ply), house, DEMO_CTX);
      let next = applyMove(state, house);
      let p = ply + 1;
      // let the board finish animating the player's sow before anything else
      const playerDur = moveDurationMs(seedsOf(state, house));
      setState(next);
      setPly(p);
      await sleep(playerDur + 450); // sow + a beat to read the result

      // Bot plays its turn(s): visible "thinking", then a slow, readable sow.
      while (!next.over && next.turn === 1) {
        setThinking(true);
        await sleep(900 + Math.random() * 500);
        const botHouse = legalHouses(next)[0];
        const botDur = moveDurationMs(seedsOf(next, 6 + botHouse));
        setThinking(false);
        await signMove(sessions[1], DEMO_MATCH_ID, BigInt(p), botHouse, DEMO_CTX);
        next = applyMove(next, botHouse);
        p += 1;
        setState(next);
        setPly(p);
        await sleep(botDur + 500); // sow + a beat to read before handing back
      }
    } finally {
      setThinking(false);
      setBusy(false);
    }
  }

  function reset() {
    setShowOverlay(false);
    setState(initialState());
    setPly(0);
  }

  return (
    <main className="pad stack" style={{ flex: 1, gap: 12, position: "relative" }}>
      <div className="row">
        <Link className="btn ghost" href="/" style={{ padding: "6px 10px" }}>
          ← Back
        </Link>
        <span className="chip">demo · move {ply}</span>
      </div>

      <div className="stack" style={{ flex: 1, justifyContent: "center", gap: 12 }}>
        <PlayerPanel name="Bot" score={state.store1} active={state.turn === 1 && !state.over} thinking={thinking} />
        <Board state={state} onPlay={play} playable={playable} />
        <PlayerPanel name="You" you score={state.store0} active={state.turn === 0 && !state.over} />
      </div>

      {showOverlay && result !== null && <GameOverlay result={result} onPlayAgain={reset} />}
    </main>
  );
}
