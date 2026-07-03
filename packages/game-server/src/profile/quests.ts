// Daily quests — three short objectives, renewed each UTC day, deterministic
// from the date (like the daily puzzle: everyone sees the same quests, no
// backend randomness to store). Progress lives on the durable player profile;
// completing all three marks a "perfect day", a counter that only ever grows.
//
// All logic here is pure (profile in → profile out) so it unit-tests without
// stores or clocks; main.ts wires it into the existing game-result and
// daily-solve paths.

import { dayKey, type PlayerProfile } from "./store.js";

export interface QuestDef {
  id: "solveDaily" | "playGames" | "winGames";
  label: string;
  target: number;
}

/** Per-day progress, stored on the profile and reset on day rollover. */
export interface QuestProgress {
  day: string; // UTC YYYY-MM-DD this progress belongs to
  playGames: number;
  winGames: number;
  solvedDaily: boolean;
  /** perfect-day already counted for this day (guards double-increment). */
  rewarded: boolean;
}

export function emptyProgress(day: string): QuestProgress {
  return { day, playGames: 0, winGames: 0, solvedDaily: false, rewarded: false };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The day's quest set — same for every player, varies a little day to day. */
export function questsFor(day: string): QuestDef[] {
  const h = hash(day);
  const play = 2 + (h % 2); // 2 or 3
  const win = 1 + ((h >>> 3) % 2); // 1 or 2 — unsigned shift: `>>` re-signs the hash and can yield 0
  return [
    { id: "solveDaily", label: "Solve the daily puzzle", target: 1 },
    { id: "playGames", label: `Play ${play} games`, target: play },
    { id: "winGames", label: `Win ${win} game${win > 1 ? "s" : ""}`, target: win },
  ];
}

/** Today's progress off a profile, rolling over stale days. The daily-solve
 *  flag derives from the profile's own `lastDailyDone` (the streak's source of
 *  truth) rather than trusting a separately-written boolean — the two fields
 *  once disagreed on screen (streak said "solved", quest said "not yet"),
 *  which is exactly the kind of inconsistency a player reads as "broken". */
export function currentProgress(p: Pick<PlayerProfile, "quests" | "lastDailyDone">, now = new Date()): QuestProgress {
  const today = dayKey(now);
  const base = p.quests.day === today ? p.quests : emptyProgress(today);
  return { ...base, solvedDaily: base.solvedDaily || p.lastDailyDone === today };
}

function counted(progress: QuestProgress, id: QuestDef["id"]): number {
  if (id === "solveDaily") return progress.solvedDaily ? 1 : 0;
  if (id === "playGames") return progress.playGames;
  return progress.winGames;
}

export interface QuestState extends QuestDef {
  count: number;
  done: boolean;
}

export function questStates(progress: QuestProgress): QuestState[] {
  return questsFor(progress.day).map((q) => {
    const count = Math.min(counted(progress, q.id), q.target);
    return { ...q, count, done: count >= q.target };
  });
}

/** Once every quest is done, count the perfect day — exactly once. */
function settle(p: PlayerProfile, progress: QuestProgress): PlayerProfile {
  const allDone = questStates(progress).every((q) => q.done);
  if (allDone && !progress.rewarded) {
    return { ...p, quests: { ...progress, rewarded: true }, perfectDays: p.perfectDays + 1 };
  }
  return { ...p, quests: progress };
}

/** A finished game (casual or async) from this player's perspective. */
export function recordQuestGame(p: PlayerProfile, won: boolean, now = new Date()): PlayerProfile {
  const cur = currentProgress(p, now);
  return settle(p, { ...cur, playGames: cur.playGames + 1, winGames: cur.winGames + (won ? 1 : 0) });
}

/** Today's daily puzzle solved. */
export function recordQuestDaily(p: PlayerProfile, now = new Date()): PlayerProfile {
  const cur = currentProgress(p, now);
  return settle(p, { ...cur, solvedDaily: true });
}
