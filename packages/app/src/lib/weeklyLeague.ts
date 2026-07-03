// Weekly prize-pool league (server-side accounting, chain-fed): every settled
// cash game scores points, a share of the week's rake is the pot, top 5 paid
// out Monday 00:00 UTC. This client only reads — entry is automatic.

import type { Address } from "viem";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

export interface LeagueStanding {
  address: Address;
  points: number;
  games: number;
  wins: number;
}

export interface WeeklyLeagueSnapshot {
  /** The week's Monday, UTC, YYYY-MM-DD. */
  week: string;
  /** Epoch ms when this week's race closes. */
  endsAt: number;
  poolWei: string;
  token: Address | null;
  minGames: number;
  pairCap: number;
  standings: LeagueStanding[];
  /** How many players are ranked (met the games bar). */
  players: number;
  me: { rank: number | null; points: number; games: number; wins: number } | null;
  lastWeek: { week: string; poolWei: string; winners: { address: Address; amountWei: string }[] } | null;
}

export function weeklyLeagueEnabled(): boolean {
  return !!SERVER_URL;
}

export async function getWeeklyLeague(address?: Address): Promise<WeeklyLeagueSnapshot> {
  const qs = address ? `?address=${address}` : "";
  const res = await fetch(`${SERVER_URL}/weekly-league${qs}`);
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "league unavailable");
  return data as WeeklyLeagueSnapshot;
}

/** "3d 4h" / "5h" / "soon" — how long the race still runs. */
export function raceEndsIn(endsAt: number, now = Date.now()): string {
  const ms = endsAt - now;
  if (ms <= 0) return "soon";
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  return h > 0 ? `${h}h` : `${Math.max(1, Math.floor(ms / 60_000))}m`;
}
