import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { streakNudgeDue, turnNudgeDue, retentionSweep } from "../src/retention.js";
import { InMemoryProfileStore, freshProfile, dayKey, prevDayKey } from "../src/profile/store.js";
import type { Notification } from "../src/notifications/notifier.js";
import type { AsyncMatchSummary } from "../src/async-match.js";

const A: Address = "0x000000000000000000000000000000000000000A";

const EVENING = new Date("2026-07-02T18:30:00Z"); // past the 17:00 UTC window
const MORNING = new Date("2026-07-02T09:00:00Z");
const TODAY = dayKey(EVENING);
const YESTERDAY = prevDayKey(EVENING);

function aliveProfile() {
  return { ...freshProfile(A), streak: 6, lastDailyDone: YESTERDAY };
}

describe("streakNudgeDue", () => {
  it("fires in the evening for a streak that would die at midnight", () => {
    expect(streakNudgeDue(aliveProfile(), EVENING)).toBe(true);
  });

  it("stays quiet in the morning — plenty of day left", () => {
    expect(streakNudgeDue(aliveProfile(), MORNING)).toBe(false);
  });

  it("stays quiet once today's puzzle is already solved", () => {
    expect(streakNudgeDue({ ...aliveProfile(), lastDailyDone: TODAY }, EVENING)).toBe(false);
  });

  it("stays quiet for an already-dead streak (no 'you lost it' spam)", () => {
    expect(streakNudgeDue({ ...aliveProfile(), lastDailyDone: "2026-06-25" }, EVENING)).toBe(false);
  });

  it("nudges at most once per day", () => {
    expect(streakNudgeDue({ ...aliveProfile(), lastStreakNudge: TODAY }, EVENING)).toBe(false);
  });
});

function match(over: {}): Pick<AsyncMatchSummary, "yourTurn" | "over" | "updatedAt"> {
  return { yourTurn: true, over: false, updatedAt: EVENING.getTime() - 25 * 3600_000, ...over };
}

describe("turnNudgeDue", () => {
  it("fires when a live match has waited on the player for over a day", () => {
    expect(turnNudgeDue(freshProfile(A), [match({})], EVENING)).toBe(true);
  });

  it("stays quiet for a fresh turn, a finished game, or the opponent's turn", () => {
    expect(turnNudgeDue(freshProfile(A), [match({ updatedAt: EVENING.getTime() - 3600_000 })], EVENING)).toBe(false);
    expect(turnNudgeDue(freshProfile(A), [match({ over: true })], EVENING)).toBe(false);
    expect(turnNudgeDue(freshProfile(A), [match({ yourTurn: false })], EVENING)).toBe(false);
  });

  it("nudges at most once per day", () => {
    expect(turnNudgeDue({ ...freshProfile(A), lastTurnNudge: TODAY }, [match({})], EVENING)).toBe(false);
  });
});

describe("retentionSweep", () => {
  it("sends the streak nudge, stamps the dedupe day, and skips on the next sweep", async () => {
    const profiles = new InMemoryProfileStore();
    await profiles.save(aliveProfile());
    const sent: { address: Address; n: Notification }[] = [];
    const deps = {
      profiles,
      listMatchesFor: async () => [],
      notify: async (address: Address, n: Notification) => {
        sent.push({ address, n });
      },
    };

    await retentionSweep(deps, EVENING);
    expect(sent).toHaveLength(1);
    expect(sent[0].n.tag).toBe("awale-streak");
    expect(sent[0].n.url).toBe("/daily");

    await retentionSweep(deps, EVENING); // same evening again — deduped
    expect(sent).toHaveLength(1);
  });

  it("one player's failure never blocks the rest", async () => {
    const profiles = new InMemoryProfileStore();
    const B: Address = "0x000000000000000000000000000000000000000b";
    await profiles.save({ ...aliveProfile(), address: A });
    await profiles.save({ ...aliveProfile(), address: B });
    const sent: Address[] = [];
    await retentionSweep(
      {
        profiles,
        listMatchesFor: async () => [],
        notify: async (address: Address) => {
          if (address.toLowerCase() === A.toLowerCase()) throw new Error("push service down");
          sent.push(address);
        },
      },
      EVENING,
    );
    expect(sent.map((a) => a.toLowerCase())).toContain(B.toLowerCase());
  });
});
