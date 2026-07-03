import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  questsFor,
  questStates,
  currentProgress,
  emptyProgress,
  recordQuestGame,
  recordQuestDaily,
  recordQuestPractice,
} from "../src/profile/quests.js";
import { freshProfile, dayKey, type PlayerProfile } from "../src/profile/store.js";

const A: Address = "0x000000000000000000000000000000000000000A";
const NOW = new Date("2026-07-02T12:00:00Z");
const TODAY = dayKey(NOW);

/** A profile with online history — sees the standard quest set, not the
 *  gentler beginner one (see isBeginner). */
function veteran(p: PlayerProfile): PlayerProfile {
  return { ...p, gamesPlayed: 50 };
}

function playUntilPerfect(p: PlayerProfile, now = NOW): PlayerProfile {
  p = recordQuestDaily(p, now);
  const defs = questsFor(dayKey(now));
  const playTarget = defs.find((q) => q.id === "playGames")!.target;
  for (let i = 0; i < playTarget; i++) p = recordQuestGame(p, true, now); // win every game
  return p;
}

describe("quest generation", () => {
  it("is deterministic per day and always three quests", () => {
    const a = questsFor("2026-07-02");
    const b = questsFor("2026-07-02");
    expect(a).toEqual(b);
    expect(a.map((q) => q.id)).toEqual(["solveDaily", "playGames", "winGames"]);
  });

  it("targets stay in their playable ranges across many days", () => {
    for (let d = 1; d <= 28; d++) {
      const qs = questsFor(`2026-07-${String(d).padStart(2, "0")}`);
      const play = qs.find((q) => q.id === "playGames")!;
      const win = qs.find((q) => q.id === "winGames")!;
      expect(play.target).toBeGreaterThanOrEqual(2);
      expect(play.target).toBeLessThanOrEqual(3);
      expect(win.target).toBeGreaterThanOrEqual(1);
      expect(win.target).toBeLessThanOrEqual(2);
      expect(win.target).toBeLessThanOrEqual(play.target); // never impossible
    }
  });
});

describe("quest progress", () => {
  it("games and the daily solve advance the right counters", () => {
    let p = freshProfile(A);
    p = recordQuestGame(p, false, NOW); // played, lost
    p = recordQuestGame(p, true, NOW); // played, won
    p = recordQuestDaily(p, NOW);
    const states = questStates(currentProgress(p, NOW));
    expect(states.find((q) => q.id === "playGames")!.count).toBe(2);
    expect(states.find((q) => q.id === "winGames")!.count).toBe(1);
    expect(states.find((q) => q.id === "solveDaily")!.done).toBe(true);
  });

  it("progress from yesterday resets on today's first event", () => {
    const yesterdayNoon = new Date("2026-07-01T12:00:00Z");
    let p = recordQuestGame(freshProfile(A), true, yesterdayNoon);
    expect(p.quests.day).toBe("2026-07-01");
    p = recordQuestGame(p, true, NOW);
    expect(p.quests.day).toBe(TODAY);
    expect(p.quests.playGames).toBe(1); // fresh count, not carried over
  });

  it("a perfect day is counted exactly once, even with more games after", () => {
    let p = playUntilPerfect(veteran(freshProfile(A)));
    expect(p.perfectDays).toBe(1);
    p = recordQuestGame(p, true, NOW); // keep playing past completion
    p = recordQuestDaily(p, NOW);
    expect(p.perfectDays).toBe(1);
  });

  it("perfect days accumulate across days", () => {
    let p = playUntilPerfect(veteran(freshProfile(A)), new Date("2026-07-01T12:00:00Z"));
    p = playUntilPerfect(p, NOW);
    expect(p.perfectDays).toBe(2);
  });

  it("counts cap at the target in the resolved states", () => {
    let progress = emptyProgress(TODAY);
    for (let i = 0; i < 10; i++) progress = { ...progress, playGames: progress.playGames + 1 };
    const play = questStates(progress).find((q) => q.id === "playGames")!;
    expect(play.count).toBe(play.target);
    expect(play.done).toBe(true);
  });
});

describe("beginner quests", () => {
  it("a brand-new player gets the gentle set, stable all day", () => {
    let p = freshProfile("0x000000000000000000000000000000000000000A");
    let progress = currentProgress(p, NOW);
    expect(questStates(progress, true).map((q) => q.id)).toEqual(["solveDaily", "tryPractice", "playGames"]);
    // finishing the first online game must NOT flip the set mid-day
    p = { ...p, gamesPlayed: 1 };
    p = recordQuestGame(p, true, NOW);
    progress = currentProgress(p, NOW);
    expect(p.gamesPlayed - progress.playGames <= 0).toBe(true); // still beginner today
  });

  it("practice completes the beginner quest and a full gentle day is perfect", () => {
    let p = freshProfile("0x000000000000000000000000000000000000000A");
    p = recordQuestDaily(p, NOW);
    p = recordQuestPractice(p, NOW);
    p = { ...p, gamesPlayed: 1 };
    p = recordQuestGame(p, true, NOW); // the "play 1 game online" quest
    expect(p.perfectDays).toBe(1);
  });
});
