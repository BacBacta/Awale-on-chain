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
  id: "solveDaily" | "playGames" | "winGames" | "tryPractice";
  label: string;
  target: number;
}

/** Per-day progress, stored on the profile and reset on day rollover. */
export interface QuestProgress {
  day: string; // UTC YYYY-MM-DD this progress belongs to
  playGames: number;
  winGames: number;
  /** practice-vs-AI games finished today (reported by the client — vanity
   *  stakes only, so a spoofed count buys nothing). */
  practiceGames: number;
  solvedDaily: boolean;
  /** perfect-day already counted for this day (guards double-increment). */
  rewarded: boolean;
}

export function emptyProgress(day: string): QuestProgress {
  return { day, playGames: 0, winGames: 0, practiceGames: 0, solvedDaily: false, rewarded: false };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The day's quest set — same for every player, varies a little day to day.
 *  A brand-new player (no finished online games before today) gets a gentler
 *  set: the standard "win 2 games" was uncompletable on day one for someone
 *  still learning against the AI, which made the very first quest screen read
 *  as failure. */
export function questsFor(day: string, beginner = false): QuestDef[] {
  if (beginner) {
    return [
      { id: "solveDaily", label: "Solve the daily puzzle", target: 1 },
      { id: "tryPractice", label: "Play a practice game vs the AI", target: 1 },
      { id: "playGames", label: "Play 1 game online", target: 1 },
    ];
  }
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
  return {
    ...base,
    practiceGames: base.practiceGames ?? 0, // records saved before this field existed
    solvedDaily: base.solvedDaily || p.lastDailyDone === today,
  };
}

/** Had this player finished zero online games before today started? Stable
 *  for the whole day (today's own games are subtracted back out), so the
 *  quest set can't flip mid-day underneath the player. */
export function isBeginner(p: Pick<PlayerProfile, "gamesPlayed">, progress: QuestProgress): boolean {
  return p.gamesPlayed - progress.playGames <= 0;
}

function counted(progress: QuestProgress, id: QuestDef["id"]): number {
  if (id === "solveDaily") return progress.solvedDaily ? 1 : 0;
  if (id === "playGames") return progress.playGames;
  if (id === "tryPractice") return progress.practiceGames;
  return progress.winGames;
}

export interface QuestState extends QuestDef {
  count: number;
  done: boolean;
}

export function questStates(progress: QuestProgress, beginner = false): QuestState[] {
  return questsFor(progress.day, beginner).map((q) => {
    const count = Math.min(counted(progress, q.id), q.target);
    return { ...q, count, done: count >= q.target };
  });
}

/** Once every quest is done, count the perfect day — exactly once. */
function settle(p: PlayerProfile, progress: QuestProgress): PlayerProfile {
  const allDone = questStates(progress, isBeginner(p, progress)).every((q) => q.done);
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

/** A practice-vs-AI game finished (client-reported; vanity stakes only). */
export function recordQuestPractice(p: PlayerProfile, now = new Date()): PlayerProfile {
  const cur = currentProgress(p, now);
  return settle(p, { ...cur, practiceGames: cur.practiceGames + 1 });
}
