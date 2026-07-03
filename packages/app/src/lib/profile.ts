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
}

export interface LeaderRow {
  address: Address;
  elo: number;
  gamesPlayed: number;
  gamesWon: number;
}

/** Display tier for a skill rating — themed on the game's own verbs. */
export function rankFor(elo: number): { name: string; icon: string } {
  if (elo >= 1550) return { name: "Grandmaster", icon: "👑" };
  if (elo >= 1400) return { name: "Captor", icon: "🏆" };
  if (elo >= 1275) return { name: "Harvester", icon: "🌾" };
  if (elo >= 1150) return { name: "Sower", icon: "✋" };
  return { name: "Seedling", icon: "🌱" };
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
