// Persistence interfaces. The server logic depends only on these; concrete
// adapters (in-memory for tests, Redis for live state, Postgres for history)
// implement them. Live match state is ephemeral and snapshot-serializable;
// ratings and results are durable.

import type { Address } from "viem";
import type { MatchSnapshot } from "../match.js";

/** Live match snapshots, for crash recovery / horizontal scaling (Redis). */
export interface LiveMatchStore {
  save(snap: MatchSnapshot): Promise<void>;
  load(matchId: bigint): Promise<MatchSnapshot | null>;
  remove(matchId: bigint): Promise<void>;
  list(): Promise<bigint[]>;
}

// TODO(rating): a future pass could replace plain Elo with Glicko-2 (rating +
// deviation + volatility) for better cold-start and inactivity handling. That
// changes the STORAGE shape here (two more fields per pool) and the leaderboard
// semantics (rank by conservative rating, not raw), so it's deliberately out of
// scope for P1-5 — see the mission's non-goals.
export interface PlayerRating {
  address: Address;
  /** Live (blitz/cash) rating — the leaderboard + live matchmaking rating.
   *  `elo` mirrors it for backward compatibility. */
  eloLive: number;
  /** Correspondence (async) rating, kept separate from live. */
  eloAsync: number;
  /** Deprecated single rating, mirror of eloLive (migrated from old records). */
  elo: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
}

/** Read path migration (P1-5): an old serialized rating has only `elo` — seed
 *  both pools from it so nothing is lost when it loads. */
export function reviveRating(address: Address, parsed: Partial<PlayerRating>): PlayerRating {
  const base = { ...newRating(address), ...parsed };
  if (parsed.eloLive === undefined && typeof parsed.elo === "number") {
    base.eloLive = parsed.elo;
    base.eloAsync = parsed.eloAsync ?? parsed.elo;
  }
  base.elo = base.eloLive;
  return base;
}

export interface MatchResult {
  matchId: bigint;
  winner: number; // 0, 1, or 2 (draw)
  player0: Address;
  player1: Address;
  timestamp: number;
}

/** Durable ratings + match history (Postgres). */
export interface LeaderboardStore {
  getRating(address: Address): Promise<PlayerRating>;
  setRating(rating: PlayerRating): Promise<void>;
  recordResult(result: MatchResult): Promise<void>;
  top(n: number): Promise<PlayerRating[]>;
}

export const DEFAULT_ELO = 1200;

export function newRating(address: Address): PlayerRating {
  return { address, eloLive: DEFAULT_ELO, eloAsync: DEFAULT_ELO, elo: DEFAULT_ELO, games: 0, wins: 0, losses: 0, draws: 0 };
}
