// Retention sweep: the scheduled nudges that bring players back.
//
// Decision logic is pure (given a profile and a clock, is a nudge due?) so it
// unit-tests without timers or Redis — the same shape as keeperActions. The
// runner in main.ts iterates profiles on an interval and sends at most one
// nudge of each kind per player per UTC day (deduped via the profile itself).

import type { Address } from "viem";
import type { AsyncMatchSummary } from "./async-match.js";
import type { Notification } from "./notifications/notifier.js";
import { dayKey, prevDayKey, type PlayerProfile } from "./profile/store.js";

/** Evening window (UTC hours) when a "streak expires tonight" nudge makes sense. */
const STREAK_NUDGE_FROM_HOUR = 17;

/**
 * A streak-expiry nudge is due when the player solved *yesterday* but not yet
 * today, the evening is closing in, and we haven't nudged them today. Someone
 * whose streak already died gets nothing — "you lost it" is churn fuel, not
 * retention.
 */
export function streakNudgeDue(p: PlayerProfile, now = new Date()): boolean {
  if (p.lastDailyDone !== prevDayKey(now)) return false; // not alive, or already solved today
  if (p.streak < 1) return false;
  if (p.lastStreakNudge === dayKey(now)) return false; // already nudged today
  return now.getUTCHours() >= STREAK_NUDGE_FROM_HOUR;
}

export function streakNudge(p: PlayerProfile): Notification {
  return {
    title: `🔥 Your ${p.streak}-day streak ends tonight`,
    body: "Solve today's puzzle to keep it going — it takes a minute.",
    url: "/daily",
    tag: "awale-streak",
  };
}

/** How long a correspondence turn may sit before we re-nudge (the move itself
 *  already triggered a notifyTurn; this is the "you forgot" follow-up). */
const STALE_TURN_MS = 24 * 60 * 60 * 1000;

/**
 * A your-turn reminder is due when at least one live async match has been
 * waiting on this player for over a day, and we haven't reminded them today.
 */
export function turnNudgeDue(
  p: PlayerProfile,
  matches: Pick<AsyncMatchSummary, "yourTurn" | "over" | "updatedAt">[],
  now = new Date(),
): boolean {
  if (p.lastTurnNudge === dayKey(now)) return false;
  return matches.some((m) => m.yourTurn && !m.over && now.getTime() - m.updatedAt >= STALE_TURN_MS);
}

export function turnNudge(count: number): Notification {
  return {
    title: "Awalé — opponents are waiting",
    body: count === 1 ? "A game has been waiting on your move since yesterday." : `${count} games are waiting on your move.`,
    url: "/matches",
    tag: "awale-stale-turn",
  };
}

export interface RetentionDeps {
  profiles: { list(): Promise<Address[]>; get(a: Address): Promise<PlayerProfile | null>; save(p: PlayerProfile): Promise<void> };
  listMatchesFor(address: Address): Promise<AsyncMatchSummary[]>;
  notify(address: Address, n: Notification): Promise<void>;
}

/** One sweep over every profile. Errors on one player never block the rest. */
export async function retentionSweep(deps: RetentionDeps, now = new Date()): Promise<void> {
  const addresses = await deps.profiles.list();
  for (const address of addresses) {
    try {
      const p = await deps.profiles.get(address);
      if (!p) continue;

      if (streakNudgeDue(p, now)) {
        await deps.notify(address, streakNudge(p));
        await deps.profiles.save({ ...p, lastStreakNudge: dayKey(now) });
        continue; // one nudge per sweep per player — don't stack notifications
      }

      const matches = await deps.listMatchesFor(address);
      if (turnNudgeDue(p, matches, now)) {
        const stale = matches.filter((m) => m.yourTurn && !m.over && now.getTime() - m.updatedAt >= STALE_TURN_MS);
        await deps.notify(address, turnNudge(stale.length));
        await deps.profiles.save({ ...p, lastTurnNudge: dayKey(now) });
      }
    } catch (err) {
      console.warn(`[retention] sweep failed for ${address}: ${(err as Error).message}`);
    }
  }
}
