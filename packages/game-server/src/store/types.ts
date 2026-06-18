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

export interface PlayerRating {
  address: Address;
  elo: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
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
  return { address, elo: DEFAULT_ELO, games: 0, wins: 0, losses: 0, draws: 0 };
}
