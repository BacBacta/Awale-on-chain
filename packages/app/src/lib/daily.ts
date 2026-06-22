// Daily puzzle + streak — a fully client-side, deterministic-per-day reason to
// return. The puzzle is a mid-game position where the side to move (the player)
// can capture; the solution is the move that captures the most. Generated from a
// date seed so everyone gets the same puzzle each day, with no backend.

import { initialState, applyMove, legalMovesMask, type GameState } from "../../../engine/src/awale.js";
import { chooseMove } from "../../../engine/src/ai.js";

export function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}
function legalHouses(s: GameState): number[] {
  const m = legalMovesMask(s);
  const out: number[] = [];
  for (let h = 0; h < 6; h++) if (m & (1 << h)) out.push(h);
  return out;
}
/** Seeds the mover sends to their store by playing house `h`. */
export function captureGain(s: GameState, h: number): number {
  const before = s.turn === 0 ? s.store0 : s.store1;
  const r = applyMove(s, h);
  const after = s.turn === 0 ? r.store0 : r.store1;
  return after - before;
}

export interface Puzzle {
  state: GameState;
  solution: number[]; // houses (0..5) that achieve the goal
  bestGain: number; // seeds captured by the best move (0 → "find the best move")
  goal: string;
}

export function dailyPuzzle(dateStr = todayKey()): Puzzle {
  const base = hash(dateStr);
  for (let attempt = 0; attempt < 40; attempt++) {
    const r = rng(base + attempt * 2654435761);
    let s = initialState();
    const plies = 8 + Math.floor(r() * 12);
    let ok = true;
    for (let i = 0; i < plies; i++) {
      const hs = legalHouses(s);
      if (hs.length === 0 || s.over) {
        ok = false;
        break;
      }
      s = applyMove(s, hs[Math.floor(r() * hs.length)]);
    }
    if (!ok || s.over) continue;
    if (s.turn === 1) {
      // ensure the human (player 0) is to move
      const hs = legalHouses(s);
      if (hs.length === 0) continue;
      s = applyMove(s, hs[Math.floor(r() * hs.length)]);
    }
    if (s.over || s.turn !== 0) continue;

    const hs = legalHouses(s);
    let best = 0;
    let solution: number[] = [];
    for (const h of hs) {
      const g = captureGain(s, h);
      if (g > best) {
        best = g;
        solution = [h];
      } else if (g === best && g > 0) {
        solution.push(h);
      }
    }
    if (best > 0) return { state: s, solution, bestGain: best, goal: "Capture as many seeds as you can in one move." };
  }

  // Fallback (rare): no capture available — solve "find the best move" via the AI.
  let s = initialState();
  const r = rng(base);
  for (let i = 0; i < 10 && !s.over; i++) {
    const hs = legalHouses(s);
    s = applyMove(s, hs[Math.floor(r() * hs.length)]);
  }
  if (s.turn !== 0 && !s.over) s = applyMove(s, legalHouses(s)[0]);
  const sol = s.over ? [] : [chooseMove(s, "hard")];
  return { state: s, solution: sol, bestGain: 0, goal: "Find the strongest move." };
}

// --- streak (localStorage) ---

interface Streak {
  count: number;
  lastDone: string; // date key of the last solved day
}

function readStreak(): Streak {
  try {
    const raw = localStorage.getItem("awale_daily");
    if (raw) return JSON.parse(raw) as Streak;
  } catch {
    /* ignore */
  }
  return { count: 0, lastDone: "" };
}

export function streakCount(): number {
  const s = readStreak();
  // streak is "alive" only if solved today or yesterday
  const today = todayKey();
  const yest = todayKey(new Date(Date.now() - 86400000));
  return s.lastDone === today || s.lastDone === yest ? s.count : 0;
}

export function solvedToday(): boolean {
  return readStreak().lastDone === todayKey();
}

/** Record today's solve; returns the new streak count. */
export function recordSolved(): number {
  const s = readStreak();
  const today = todayKey();
  if (s.lastDone === today) return s.count;
  const yest = todayKey(new Date(Date.now() - 86400000));
  const count = s.lastDone === yest ? s.count + 1 : 1;
  try {
    localStorage.setItem("awale_daily", JSON.stringify({ count, lastDone: today }));
  } catch {
    /* ignore */
  }
  return count;
}
