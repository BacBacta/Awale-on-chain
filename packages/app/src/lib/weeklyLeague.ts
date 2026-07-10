// Weekly prize-pool league (server-side accounting, chain-fed): every settled
// cash game scores points and a share of the week's rake is the pot. Monday
// 00:00 UTC the podium (top 3) takes 40/20/10% and every other ranked player
// splits the rest pro-rata to points. Prizes are CREDITED, not pushed — the
// winner collects with one tap (POST /league/claim).

import { parseUnits, type Address, type Hex } from "viem";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

/** Player-facing name of a specially-funded race. */
export const BLITZ_LABEL = "Weekend Blitz";

/**
 * A "blitz" is a race whose pot has been provisioned well above the few cents a
 * normal week's rake makes (via the operator seed) — i.e. a funded special
 * event. It drives the premium home banner and the dedicated Blitz tab, and
 * auto-clears at Monday's rollover when the pool resets. Threshold is
 * NEXT_PUBLIC_BLITZ_MIN_USD (default $5), in the stake token's units.
 */
export function isBlitzActive(poolWei: string, decimals: number): boolean {
  try {
    const min = process.env.NEXT_PUBLIC_BLITZ_MIN_USD ?? "5";
    return BigInt(poolWei) >= parseUnits(min as `${number}`, decimals);
  } catch {
    return false;
  }
}

/** Minimal ABI for claiming a Weekly-race prize from the on-chain distributor. */
export const weeklyPrizesAbi = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "round", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },
] as const;

/** An escrowed, sealed-on-chain prize the winner claims themselves (trust-
 *  minimised path). Null when no distributor is configured (custodial mode) or
 *  this wallet has nothing to claim on-chain. */
export interface OnchainPrize {
  distributor: Address;
  round: bigint;
  token: Address; // the prize token — the feeCurrency is derived from it
  amountWei: bigint;
  proof: Hex[];
}

export async function getOnchainPrize(address: Address): Promise<OnchainPrize | null> {
  if (!SERVER_URL) return null;
  try {
    const res = await fetch(`${SERVER_URL}/weekly-prizes?address=${address}`, { signal: AbortSignal.timeout(5000) });
    const d = (await res.json()) as { distributor?: Address | null; round?: string | null; token?: Address; amountWei?: string; proof?: Hex[] };
    if (!res.ok || !d.distributor || !d.round || !d.token || !d.amountWei) return null;
    return { distributor: d.distributor, round: BigInt(d.round), token: d.token, amountWei: BigInt(d.amountWei), proof: d.proof ?? [] };
  } catch {
    return null;
  }
}

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

export interface PendingPrize {
  week: string;
  token: Address;
  amountWei: string;
  rank: number;
}

/** Prizes waiting for this wallet (credited at Monday's rollover). */
export async function getPendingPrizes(address: Address): Promise<{ prizes: PendingPrize[]; totalWei: bigint }> {
  const res = await fetch(`${SERVER_URL}/league/prizes?address=${address}`, { signal: AbortSignal.timeout(5000) });
  const data = (await res.json()) as { prizes?: PendingPrize[]; totalWei?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? "prizes unavailable");
  return { prizes: data.prizes ?? [], totalWei: BigInt(data.totalWei ?? "0") };
}

/** One tap: the server pays everything pending to the wallet. */
export async function claimPrizes(address: Address): Promise<{ paidWei: bigint; tx: string | null }> {
  const res = await fetch(`${SERVER_URL}/league/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const data = (await res.json()) as { paidWei?: string; tx?: string | null; error?: string };
  if (!res.ok) throw new Error(data.error ?? "collect failed — try again");
  return { paidWei: BigInt(data.paidWei ?? "0"), tx: data.tx ?? null };
}
