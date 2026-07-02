// Server-side player profile — the durable, cross-device home of the daily
// streak and play stats, keyed by wallet address. localStorage (lib/daily.ts)
// stays as an offline-friendly cache; every call here degrades gracefully to
// null so the app never blocks on the profile service.

import type { Address } from "viem";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

export interface PlayerProfile {
  address: Address;
  streak: number; // live streak (0 once a day has been missed)
  lastDailyDone: string; // UTC YYYY-MM-DD, "" if never
  gamesPlayed: number;
  gamesWon: number;
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

/**
 * Record today's daily-puzzle solve server-side. `local` carries the device's
 * localStorage streak for one-time adoption (accepted only while the server
 * has no history for this address). Returns the authoritative streak, or null
 * when offline/unconfigured — callers fall back to the local count.
 */
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
