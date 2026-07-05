// Server-side player profile — the durable, cross-device home of the daily
// streak and play stats, keyed by wallet address. localStorage (lib/daily.ts)
// stays as an offline-friendly cache; every call here degrades gracefully to
// null so the app never blocks on the profile service.

import type { Address } from "viem";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

export interface QuestState {
  id: "solveDaily" | "playGames" | "winGames";
  label: string;
  target: number;
  count: number;
  done: boolean;
}

export interface PlayerProfile {
  address: Address;
  streak: number; // live streak (0 once a day has been missed)
  lastDailyDone: string; // UTC YYYY-MM-DD, "" if never
  gamesPlayed: number;
  gamesWon: number;
  elo: number;
  /** Today's quests, already resolved (labels, targets, progress). */
  quests: QuestState[];
  perfectDays: number;
  /** Self proof-of-personhood done for this wallet (false when Self is off). */
  verified?: boolean;
}

export interface LeaderRow {
  address: Address;
  elo: number;
  gamesPlayed: number;
  gamesWon: number;
}

/** THE single source of truth for the skill-rank ladder (Seedling →
 *  Grandmaster), themed on the game's own verbs. `min` = the rating at which
 *  the tier is reached. Everything that shows tiers or the climb imports this
 *  — no more four copies drifting apart. Ordered low → high. */
export interface Tier {
  name: string;
  icon: string;
  min: number;
}
export const TIERS: readonly Tier[] = [
  { name: "Seedling", icon: "🌱", min: 0 },
  { name: "Sower", icon: "✋", min: 1150 },
  { name: "Harvester", icon: "🌾", min: 1275 },
  { name: "Captor", icon: "🏆", min: 1400 },
  { name: "Grandmaster", icon: "👑", min: 1550 },
];

/** Display tier for a skill rating. */
export function rankFor(elo: number): Tier {
  let tier = TIERS[0];
  for (const t of TIERS) if (elo >= t.min) tier = t;
  return tier;
}

/** Progress toward the next tier: current + next tier and 0..1 fraction. */
export function tierProgress(elo: number): { cur: Tier; next: Tier | null; pct: number; toNext: number } {
  let i = 0;
  for (let k = 0; k < TIERS.length; k++) if (elo >= TIERS[k].min) i = k;
  const cur = TIERS[i];
  const next = TIERS[i + 1] ?? null;
  const pct = next ? Math.max(0.04, Math.min(1, (elo - cur.min) / (next.min - cur.min))) : 1;
  return { cur, next, pct, toNext: next ? next.min - elo : 0 };
}

export function profileEnabled(): boolean {
  return !!SERVER_URL;
}

export async function getProfile(address: Address): Promise<PlayerProfile | null> {
  if (!SERVER_URL) return null;
  try {
    const res = await fetch(`${SERVER_URL}/profile?address=${address}`);
    if (!res.ok) return null;
    const { profile } = (await res.json()) as { profile: PlayerProfile };
    return profile;
  } catch {
    return null;
  }
}

/** Skill leaderboard: players ranked by Elo, best first. [] when unavailable. */
export async function getLeaderboard(n = 20): Promise<LeaderRow[]> {
  if (!SERVER_URL) return [];
  try {
    const res = await fetch(`${SERVER_URL}/leaderboard?n=${n}`);
    if (!res.ok) return [];
    const { leaders } = (await res.json()) as { leaders: LeaderRow[] };
    return leaders;
  } catch {
    return [];
  }
}

/**
 * Record today's daily-puzzle solve server-side. `local` carries the device's
 * localStorage streak for one-time adoption (accepted only while the server
 * has no history for this address). Returns the authoritative streak, or null
 * when offline/unconfigured — callers fall back to the local count.
 */
/** A practice-vs-AI game finished — feeds the beginner quest (vanity only). */
export function reportPracticePlayed(address: Address): void {
  if (!SERVER_URL) return;
  void fetch(`${SERVER_URL}/profile/practice-played`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  }).catch(() => {});
}

/**
 * Referral capture: a visitor who arrived via /?ref=<address> is remembered
 * on-device; once they connect, the pending referral is registered server-side
 * and converts (into capped league points for the referrer) only when this
 * player settles their first cash game — i.e. after they've paid real rake.
 */
export function captureReferrer(): void {
  try {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref && /^0x[0-9a-fA-F]{40}$/.test(ref) && !localStorage.getItem("awale_ref")) {
      localStorage.setItem("awale_ref", ref.toLowerCase());
    }
  } catch {
    /* ignore */
  }
}

export function claimReferral(address: Address): void {
  if (!SERVER_URL) return;
  try {
    const ref = localStorage.getItem("awale_ref");
    if (!ref || ref === address.toLowerCase() || localStorage.getItem("awale_ref_claimed")) return;
    void fetch(`${SERVER_URL}/referral/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referee: address, referrer: ref }),
    }).then((r) => {
      if (r.ok) localStorage.setItem("awale_ref_claimed", "1");
    });
  } catch {
    /* ignore */
  }
}

export async function reportDailySolve(
  address: Address,
  local?: { count: number; lastDone: string },
): Promise<number | null> {
  if (!SERVER_URL) return null;
  try {
    const res = await fetch(`${SERVER_URL}/profile/daily-solved`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, local }),
    });
    if (!res.ok) return null;
    const { streak } = (await res.json()) as { streak: number };
    return streak;
  } catch {
    return null;
  }
}
