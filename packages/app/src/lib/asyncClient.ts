// Correspondence (async) play over HTTP — make a move, leave, come back when the
// opponent has replied. Works everywhere (polling; no socket/push). Identity is
// the per-match session key (no wallet needed for casual), so role is determined
// by which player slot holds your session address.

import type { Address, Hex } from "viem";
import type { GameState } from "../../../engine/src/awale.js";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

export interface AsyncState {
  matchId: string;
  state: GameState;
  turn: number;
  over: boolean;
  ply: number;
  players: [Address, Address];
  open: boolean;
  updatedAt: number;
  /** per-match inactivity-claim window (ms); null = correspondence default.
   *  Tournament bracket games are set to minutes. */
  turnClockMs: number | null;
}

// Mirrors the server's ASYNC_TURN_CLOCK_MS default — used only to decide when
// to *show* the claim button; the server is the actual authority and will
// reject a premature claim regardless of this local guess.
export const ASYNC_TURN_CLOCK_MS = 24 * 60 * 60 * 1000; // must match the server default

export function asyncEnabled(): boolean {
  return !!SERVER_URL;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "request failed");
  return data as T;
}

export async function createAsync(sessionAddress: Address): Promise<string> {
  const { matchId } = await post<{ matchId: string }>("/async/create", { address: sessionAddress, session: sessionAddress });
  return matchId;
}

export async function joinAsync(matchId: string, sessionAddress: Address): Promise<AsyncState> {
  return post<AsyncState>("/async/join", { matchId, address: sessionAddress, session: sessionAddress });
}

export async function getAsync(matchId: string): Promise<AsyncState> {
  const res = await fetch(`${SERVER_URL}/async/match?id=${matchId}`);
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "not found");
  return data as AsyncState;
}

export async function moveAsync(matchId: string, player: 0 | 1, house: number, signature: Hex): Promise<GameState> {
  const { state } = await post<{ state: GameState }>("/async/move", { matchId, player, house, signature });
  return state;
}

/** Claim a walkover: the opponent hasn't moved in days while it's their turn. */
export async function claimTimeoutAsync(matchId: string, claimant: 0 | 1): Promise<GameState> {
  const { state } = await post<{ state: GameState }>("/async/claim-timeout", { matchId, claimant });
  return state;
}

/** Leave / resign a correspondence game — the opponent wins now and is notified.
 *  Signed with the player's session key (like a move), so no one else can forfeit
 *  the game on their behalf. */
export async function resignAsync(matchId: string, player: 0 | 1, signature: Hex): Promise<GameState> {
  const { state } = await post<{ state: GameState }>("/async/resign", { matchId, player, signature });
  return state;
}

/** My role (0/1) in a match, by matching my session address to a player slot. */
export function roleOf(s: AsyncState, sessionAddress: Address): 0 | 1 | null {
  const me = sessionAddress.toLowerCase();
  if (s.players[0].toLowerCase() === me) return 0;
  if (s.players[1].toLowerCase() === me) return 1;
  return null;
}

// Device-local index of correspondence matches this player is in (identity is the
// per-match session key, so there's no single server-side address to list by).
const IDX = "awale.async";

export function recordAsyncMatch(id: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    const ids = listAsyncMatchIds();
    if (!ids.includes(id)) localStorage.setItem(IDX, JSON.stringify([id, ...ids]));
  } catch {
    /* ignore */
  }
}

export function listAsyncMatchIds(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(IDX);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
