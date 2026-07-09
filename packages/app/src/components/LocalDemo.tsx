"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  initialState,
  applyMove,
  adjudicate,
  legalMovesMask,
  repetitionCount,
  endKind,
  REPETITION_LIMIT,
  DRAW,
  type GameState,
} from "../../../engine/src/awale.js";
import { chooseMove, wouldAcceptDraw, type Difficulty } from "../../../engine/src/ai.js";
import { Board, moveDurationMs } from "./Board.js";
import { GameOverlay } from "./GameOverlay.js";
import { PlayerPanel } from "./PlayerPanel.js";
import { shareResult } from "../lib/share.js";
import { Icon } from "./Icon.js";
import { SoundToggle } from "./SoundToggle.js";
import { getEquipped, type EquippedSkin } from "../lib/skins.js";
import { createSessionKey, signMove, type SessionKey } from "../lib/session.js";
import { getInjectedProvider, connect } from "../lib/minipay.js";
import { escrowConfig } from "../lib/escrow.js";
import { reportPracticePlayed } from "../lib/profile.js";
import { track } from "../lib/analytics.js";

// Demo context — in a real match these come from the on-chain join events.
const DEMO_CTX = { chainId: 31337n, verifier: "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3" as const };
const DEMO_MATCH_ID = 1n;

function legalHouses(s: GameState): number[] {
  const mask = legalMovesMask(s);
  const out: number[] = [];
  for (let h = 0; h < 6; h++) if (mask & (1 << h)) out.push(h);
  return out;
}

/** True when the "must feed" rule is what greys out some of the player's houses:
 *  the opponent's row is empty, so only moves that hand them seeds are legal.
 *  Drives an in-context hint, since a beginner just sees houses they can't tap. */
function mustFeedActive(s: GameState): boolean {
  if (s.over || s.turn !== 0) return false;
  const oppEmpty = s.pits.slice(6, 12).reduce((a, b) => a + b, 0) === 0;
  if (!oppEmpty) return false;
  const legal = new Set(legalHouses(s));
  for (let h = 0; h < 6; h++) if (s.pits[h] > 0 && !legal.has(h)) return true;
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

/** Self-contained game vs a real Awalé AI — no server or chain needed.
 *  Untimed: this is Quick Match's AI fallback and free Practice — play at your
 *  own pace. (Only money games are timed.) */
export function LocalDemo() {
  const [state, setState] = useState<GameState>(() => initialState());
  const [ply, setPly] = useState(0);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  // Coach (first practice games): suggest the strongest move + why, so a beginner
  // learns by seeing the consequence. Fades once they've played a couple of games
  // or dismiss it. Computed off the render path — chooseMove("hard") isn't free.
  const [coachOn, setCoachOn] = useState(false);
  const [coach, setCoach] = useState<{ house: number; captures: number } | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);
  const [skin, setSkin] = useState<EquippedSkin | undefined>(undefined);
  const [drawDeclined, setDrawDeclined] = useState(false);
  // accepted move history (this demo always starts with player 0), so the same
  // repetition adjudication the server & chain run can end a stuck cycle here too
  const movesRef = useRef<number[]>([]);
  const [repWarn, setRepWarn] = useState(false);

  useEffect(() => setSkin(getEquipped()), []);

  const sessions = useMemo<[SessionKey, SessionKey]>(() => [createSessionKey(), createSessionKey()], []);

  useEffect(() => {
    if (state.over) {
      try {
        const games = Number(localStorage.getItem("awale_practice_games") ?? "0");
        localStorage.setItem("awale_practice_games", String(games + 1)); // beginner coach fades after 2
      } catch {
        /* ignore */
      }
      const t = setTimeout(() => setShowOverlay(true), 600);
      // feeds the beginner quest ("play a practice game") — best-effort,
      // needs a wallet identity to credit
      const p = getInjectedProvider();
      if (p)
        connect(p, escrowConfig()?.chainId)
          .then(({ address }) => reportPracticePlayed(address))
          .catch(() => {});
      return () => clearTimeout(t);
    }
  }, [state.over]);

  useEffect(() => {
    track("practice_start");
    try {
      localStorage.setItem("awale_played", "1"); // unlocks League/Skins in the nav
      // beginners: gentle AI + coach on. Both fade after a couple of games so a
      // returning player isn't nagged or sandbagged.
      const games = Number(localStorage.getItem("awale_practice_games") ?? "0");
      if (games < 2) setDifficulty("easy");
      if (games < 2 && localStorage.getItem("awale_coach_off") !== "1") setCoachOn(true);
    } catch {
      /* ignore */
    }
  }, []);

  // Coach pick, computed off the render path (chooseMove("hard") can take a beat).
  useEffect(() => {
    if (!coachOn || busy || state.over || state.turn !== 0) {
      setCoach(null);
      return;
    }
    let alive = true;
    const id = setTimeout(() => {
      try {
        const house = chooseMove(state, "hard");
        const captures = applyMove(state, house).store0 - state.store0;
        if (alive) setCoach({ house, captures });
      } catch {
        if (alive) setCoach(null);
      }
    }, 60);
    return () => {
      alive = false;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ply, coachOn, busy, state.over, state.turn]);

  function dismissCoach() {
    setCoachOn(false);
    setCoach(null);
    try {
      localStorage.setItem("awale_coach_off", "1");
    } catch {
      /* ignore */
    }
  }

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
      await signMove(sessions[0], DEMO_MATCH_ID, BigInt(ply), house, state, DEMO_CTX);
      // adjudicate the full history so a threefold repetition ends the game here
      // exactly as it would on the server / on-chain (not just applyMove)
      movesRef.current.push(house);
      let next = adjudicate(movesRef.current);
      let p = ply + 1;
      // let the board finish animating the player's sow before anything else
      const playerDur = moveDurationMs(seedsOf(state, house));
      setState(next);
      setPly(p);
      setRepWarn(!next.over && repetitionCount(movesRef.current) >= REPETITION_LIMIT - 1);
      await sleep(playerDur + 650); // sow + a beat to read the result

      // Bot plays its turn(s): visible "thinking", then a slow, readable sow.
      while (!next.over && next.turn === 1) {
        setThinking(true);
        await sleep(1200 + Math.random() * 600);
        const botHouse = chooseMove(next, difficulty);
        const botDur = moveDurationMs(seedsOf(next, 6 + botHouse));
        setThinking(false);
        await signMove(sessions[1], DEMO_MATCH_ID, BigInt(p), botHouse, next, DEMO_CTX);
        movesRef.current.push(botHouse);
        next = adjudicate(movesRef.current);
        p += 1;
        setState(next);
        setPly(p);
        setRepWarn(!next.over && repetitionCount(movesRef.current) >= REPETITION_LIMIT - 1);
        await sleep(botDur + 700); // sow + a beat to read before handing back
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
    movesRef.current = [];
    setRepWarn(false);
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

      {repWarn && !state.over && (
        <div
          className="chip animate-in"
          style={{ alignSelf: "center", background: "rgba(240,180,40,0.16)", color: "var(--gold)", borderColor: "var(--gold)" }}
        >
          <Icon name="info" size={14} /> Repeating position — one more repeat scores the game as it stands
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

      {/* the goal, always in view — a beginner never has to remember "why 25?" */}
      {!state.over && (
        <div className="faint" style={{ alignSelf: "center", fontSize: 12.5 }}>
          🎯 First to <b style={{ color: "var(--text)" }}>25 seeds</b> wins — you {state.store0} · AI {state.store1}
        </div>
      )}

      {/* must-feed: the one rule that silently greys out houses */}
      {mustFeedActive(state) && !state.over && (
        <div className="chip animate-in" style={{ alignSelf: "center", background: "rgba(76,229,132,0.14)", color: "var(--accent)", borderColor: "var(--accent)" }}>
          <Icon name="info" size={14} /> The AI has no seeds — you must play a move that reaches its side
        </div>
      )}

      {/* coach: point at the strongest move and say what it does */}
      {coach && !state.over && state.turn === 0 && !busy && (
        <div className="chip animate-in" style={{ alignSelf: "center", gap: 8, background: "rgba(245,196,81,0.14)", color: "var(--gold)", borderColor: "var(--gold)" }}>
          <span>
            💡{" "}
            {coach.captures > 0
              ? `Tap the gold house — you'll capture ${coach.captures} seed${coach.captures > 1 ? "s" : ""}`
              : "Tap the gold house — the strongest move here"}
          </span>
          <button className="btn ghost" style={{ padding: "2px 8px", fontSize: 11.5 }} onClick={dismissCoach}>
            Got it
          </button>
        </div>
      )}

      <div className="stack" style={{ gap: 14, marginTop: 4 }}>
        <PlayerPanel
          name={`AI · ${difficulty[0].toUpperCase() + difficulty.slice(1)}`}
          score={state.store1}
          active={state.turn === 1 && !state.over}
          thinking={thinking}
        />
        <Board state={state} onPlay={play} playable={playable} suggest={coach?.house ?? null} skin={skin} />
        <PlayerPanel name="You" you score={state.store0} active={state.turn === 0 && !state.over} />
      </div>
      <div className="spacer" />

      {showOverlay && result !== null && (
        <GameOverlay
          result={result}
          note={
            endKind(state) === "swept"
              ? "No captures were left to make — each side kept the seeds on its own row."
              : undefined
          }
          stats={{ mine: state.store0, opp: state.store1, moves: ply }}
          onPlayAgain={reset}
          onShare={() => shareResult({ result, scoreMine: state.store0, scoreOpp: state.store1 })}
        />
      )}
    </main>
  );
}
