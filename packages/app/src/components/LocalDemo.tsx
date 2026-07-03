"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { initialState, applyMove, legalMovesMask, DRAW, type GameState } from "../../../engine/src/awale.js";
import { chooseMove, wouldAcceptDraw, type Difficulty } from "../../../engine/src/ai.js";
import { Board, moveDurationMs } from "./Board.js";
import { GameOverlay } from "./GameOverlay.js";
import { PlayerPanel } from "./PlayerPanel.js";
import { shareResult } from "../lib/share.js";
import { Icon } from "./Icon.js";
import { SoundToggle } from "./SoundToggle.js";
import { getEquipped, type EquippedSkin } from "../lib/skins.js";
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

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

// Same blitz clock as live matches (3 min per player) so Practice teaches the
// exact rhythm of a real game — and so the clock is testable without a second
// player. It only starts running once the first move is played.
const BLITZ_CLOCK_MS = 3 * 60_000;

/** Self-contained game vs a real Awalé AI — no server or chain needed. */
export function LocalDemo() {
  const [state, setState] = useState<GameState>(() => initialState());
  const [ply, setPly] = useState(0);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [showOverlay, setShowOverlay] = useState(false);
  const [skin, setSkin] = useState<EquippedSkin | undefined>(undefined);
  const [drawDeclined, setDrawDeclined] = useState(false);
  const clockRef = useRef<[number, number]>([BLITZ_CLOCK_MS, BLITZ_CLOCK_MS]); // banked time
  const turnStartRef = useRef(Date.now());
  const [, setTick] = useState(0); // re-render pulse for the countdown

  useEffect(() => setSkin(getEquipped()), []);

  /** Live remaining time: the bank, minus the running turn for the mover. */
  function liveClock(player: 0 | 1): number {
    const banked = clockRef.current[player];
    if (ply === 0 || state.over || state.turn !== player) return banked;
    return Math.max(0, banked - (Date.now() - turnStartRef.current));
  }

  // Tick the display and flag whoever runs out of time.
  useEffect(() => {
    if (state.over || ply === 0) return;
    const iv = setInterval(() => {
      setTick((t) => t + 1);
      if (liveClock(0) <= 0) concede(1); // human out of time — AI wins
      else if (liveClock(1) <= 0) concede(0); // (practically never)
    }, 500);
    return () => clearInterval(iv);
  }, [state.over, ply === 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const sessions = useMemo<[SessionKey, SessionKey]>(() => [createSessionKey(), createSessionKey()], []);

  useEffect(() => {
    if (state.over) {
      const t = setTimeout(() => setShowOverlay(true), 600);
      return () => clearTimeout(t);
    }
  }, [state.over]);

  useEffect(() => {
    try {
      localStorage.setItem("awale_played", "1"); // unlocks League/Skins in the nav
    } catch {
      /* ignore */
    }
  }, []);

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
      // bank the human's thinking time (the clock starts on the first move)
      if (ply > 0) clockRef.current[0] = Math.max(0, clockRef.current[0] - (Date.now() - turnStartRef.current));
      turnStartRef.current = Date.now();
      await signMove(sessions[0], DEMO_MATCH_ID, BigInt(ply), house, DEMO_CTX);
      let next = applyMove(state, house);
      let p = ply + 1;
      // let the board finish animating the player's sow before anything else
      const playerDur = moveDurationMs(seedsOf(state, house));
      setState(next);
      setPly(p);
      await sleep(playerDur + 650); // sow + a beat to read the result

      // Bot plays its turn(s): visible "thinking", then a slow, readable sow.
      while (!next.over && next.turn === 1) {
        setThinking(true);
        await sleep(1200 + Math.random() * 600);
        const botHouse = chooseMove(next, difficulty);
        const botDur = moveDurationMs(seedsOf(next, 6 + botHouse));
        setThinking(false);
        await signMove(sessions[1], DEMO_MATCH_ID, BigInt(p), botHouse, DEMO_CTX);
        clockRef.current[1] = Math.max(0, clockRef.current[1] - (Date.now() - turnStartRef.current));
        turnStartRef.current = Date.now();
        next = applyMove(next, botHouse);
        p += 1;
        setState(next);
        setPly(p);
        await sleep(botDur + 700); // sow + a beat to read before handing back
      }
    } finally {
      setThinking(false);
      setBusy(false);
      turnStartRef.current = Date.now(); // the human's turn starts clean, after animations
    }
  }

  function reset() {
    setShowOverlay(false);
    setState(initialState());
    setPly(0);
    clockRef.current = [BLITZ_CLOCK_MS, BLITZ_CLOCK_MS];
    turnStartRef.current = Date.now();
  }

  // A stuck game (an endless cyclic position, or just not fun anymore)
  // shouldn't trap the player — resigning is always available. A draw isn't:
  // the bot only agrees if its own evaluation says the position is roughly
  // even, so a losing player can't just call the game even to dodge a loss.
  function concede(winner: 0 | 1 | typeof DRAW) {
    if (state.over) return;
    setThinking(false);
    setBusy(false);
    setState((s) => ({ ...s, over: true, winner }));
  }

  function offerDraw() {
    if (state.over) return;
    if (wouldAcceptDraw(state, 1)) {
      concede(DRAW);
    } else {
      setDrawDeclined(true);
      setTimeout(() => setDrawDeclined(false), 2500);
    }
  }

  return (
    <main className="stack" style={{ flex: 1, gap: 12, position: "relative", padding: "12px 8px" }}>
      <div className="row" style={{ padding: "0 6px" }}>
        <Link className="btn ghost" href="/" style={{ padding: "6px 10px" }}>
          <Icon name="back" size={16} /> Back
        </Link>
        <span className="row" style={{ gap: 8 }}>
          {!state.over && ply > 0 && (
            <>
              <button className="btn ghost" style={{ padding: "6px 10px", fontSize: 12.5 }} onClick={offerDraw}>
                Call it a draw
              </button>
              <button className="btn ghost" style={{ padding: "6px 10px", fontSize: 12.5 }} onClick={() => concede(1)}>
                Resign
              </button>
            </>
          )}
          <span className="chip">move {ply}</span>
          <SoundToggle />
        </span>
      </div>

      {drawDeclined && (
        <div className="chip animate-in" style={{ alignSelf: "center" }}>
          The AI declines — it thinks it&apos;s ahead
        </div>
      )}

      {ply === 0 && !busy && (
        <div className="segmented" style={{ margin: "0 6px" }}>
          {DIFFICULTIES.map((d) => (
            <button key={d} data-on={difficulty === d} onClick={() => setDifficulty(d)}>
              {d[0].toUpperCase() + d.slice(1)}
            </button>
          ))}
        </div>
      )}

      <div className="stack" style={{ gap: 14, marginTop: 4 }}>
        <PlayerPanel
          name={`AI · ${difficulty[0].toUpperCase() + difficulty.slice(1)}`}
          score={state.store1}
          active={state.turn === 1 && !state.over}
          thinking={thinking}
          clockMs={liveClock(1)}
        />
        <Board state={state} onPlay={play} playable={playable} skin={skin} />
        <PlayerPanel name="You" you score={state.store0} active={state.turn === 0 && !state.over} clockMs={liveClock(0)} />
      </div>
      <div className="spacer" />

      {showOverlay && result !== null && (
        <GameOverlay
          result={result}
          stats={{ mine: state.store0, opp: state.store1, moves: ply }}
          onPlayAgain={reset}
          onShare={() => shareResult({ result, scoreMine: state.store0, scoreOpp: state.store1 })}
        />
      )}
    </main>
  );
}
