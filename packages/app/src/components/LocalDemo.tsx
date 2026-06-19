"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { initialState, applyMove, legalMovesMask, type GameState } from "../../../engine/src/awale.js";
import { Board } from "./Board.js";
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

/** Self-contained game vs a trivial bot — no server or chain needed. */
export function LocalDemo() {
  const [state, setState] = useState<GameState>(() => initialState());
  const [ply, setPly] = useState(0);
  const [busy, setBusy] = useState(false);

  const sessions = useMemo<[SessionKey, SessionKey]>(() => [createSessionKey(), createSessionKey()], []);

  const playable = state.turn === 0 && !state.over ? legalHouses(state) : [];
  const result = state.over
    ? state.winner === 0
      ? "You win 🎉"
      : state.winner === 1
        ? "You lose"
        : "Draw"
    : null;

  async function play(house: number) {
    if (busy || state.over || state.turn !== 0) return;
    setBusy(true);
    try {
      await signMove(sessions[0], DEMO_MATCH_ID, BigInt(ply), house, DEMO_CTX);
      let next = applyMove(state, house);
      let p = ply + 1;
      while (!next.over && next.turn === 1) {
        const botHouse = legalHouses(next)[0];
        await signMove(sessions[1], DEMO_MATCH_ID, BigInt(p), botHouse, DEMO_CTX);
        next = applyMove(next, botHouse);
        p += 1;
      }
      setState(next);
      setPly(p);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="pad" style={{ display: "flex", flexDirection: "column", gap: 16, flex: 1 }}>
      <div className="row">
        <Link className="muted" href="/">
          ← Back
        </Link>
        <span className="muted">demo · move {ply}</span>
      </div>

      <Board state={state} onPlay={play} playable={playable} />

      <div className="card row">
        <span className="muted">{result ?? (state.turn === 0 ? "Your turn" : "Opponent…")}</span>
        <span className="title">
          {state.store0} – {state.store1}
        </span>
      </div>

      {state.over && (
        <button
          className="btn"
          onClick={() => {
            setState(initialState());
            setPly(0);
          }}
        >
          Play again
        </button>
      )}
    </main>
  );
}
