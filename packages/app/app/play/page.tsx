"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { initialState, applyMove, legalMovesMask, type GameState } from "../../../engine/src/awale.js";
import { Board } from "../../src/components/Board.js";
import { createSessionKey, signMove, type SessionKey } from "../../src/lib/session.js";

// Demo context — in a real match these come from the on-chain join events.
const DEMO_CTX = { chainId: 31337n, verifier: "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3" as const };
const DEMO_MATCH_ID = 1n;

function legalHouses(s: GameState): number[] {
  const mask = legalMovesMask(s);
  const out: number[] = [];
  for (let h = 0; h < 6; h++) if (mask & (1 << h)) out.push(h);
  return out;
}

export default function Play() {
  const [state, setState] = useState<GameState>(() => initialState());
  const [ply, setPly] = useState(0);
  const [busy, setBusy] = useState(false);

  // ephemeral session keys for the demo (human = South/0, bot = North/1)
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
      // sign the move with the player's session key (real digest, in-app signing)
      await signMove(sessions[0], DEMO_MATCH_ID, BigInt(ply), house, DEMO_CTX);
      let next = applyMove(state, house);
      let p = ply + 1;

      // bot (player 1) responds with the lowest legal move, also signed
      while (!next.over && next.turn === 1) {
        const houses = legalHouses(next);
        const botHouse = houses[0];
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

  function reset() {
    setState(initialState());
    setPly(0);
  }

  return (
    <main className="pad" style={{ display: "flex", flexDirection: "column", gap: 16, flex: 1 }}>
      <div className="row">
        <Link className="muted" href="/">
          ← Back
        </Link>
        <span className="muted">move {ply}</span>
      </div>

      <Board state={state} onPlay={play} playable={playable} />

      <div className="card row">
        <span className="muted">{result ?? (state.turn === 0 ? "Your turn" : "Opponent…")}</span>
        <span className="title">
          {state.store0} – {state.store1}
        </span>
      </div>

      {state.over && (
        <button className="btn" onClick={reset}>
          Play again
        </button>
      )}
    </main>
  );
}
