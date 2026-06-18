// Postgres-backed leaderboard + history. Takes a minimal query interface
// (satisfied by `pg` Pool) so the package needs no driver dependency.
//
// Exercised against a real database in integration; unit tests cover the
// in-memory store and the rating service instead.

import type { Address } from "viem";
import { type LeaderboardStore, type PlayerRating, type MatchResult, newRating } from "./types.js";

export interface PgLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** DDL to provision the tables this store expects. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ratings (
  address  TEXT PRIMARY KEY,
  elo      INTEGER NOT NULL,
  games    INTEGER NOT NULL,
  wins     INTEGER NOT NULL,
  losses   INTEGER NOT NULL,
  draws    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  match_id   NUMERIC PRIMARY KEY,
  winner     SMALLINT NOT NULL,
  player0    TEXT NOT NULL,
  player1    TEXT NOT NULL,
  ts         BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ratings_elo_idx ON ratings (elo DESC);
`;

function rowToRating(row: Record<string, unknown>): PlayerRating {
  return {
    address: row.address as Address,
    elo: Number(row.elo),
    games: Number(row.games),
    wins: Number(row.wins),
    losses: Number(row.losses),
    draws: Number(row.draws),
  };
}

export class PgLeaderboardStore implements LeaderboardStore {
  constructor(private readonly db: PgLike) {}

  async getRating(address: Address): Promise<PlayerRating> {
    const { rows } = await this.db.query("SELECT * FROM ratings WHERE address = $1", [address.toLowerCase()]);
    return rows[0] ? rowToRating(rows[0]) : newRating(address);
  }

  async setRating(r: PlayerRating): Promise<void> {
    await this.db.query(
      `INSERT INTO ratings (address, elo, games, wins, losses, draws)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (address) DO UPDATE SET
         elo = EXCLUDED.elo, games = EXCLUDED.games, wins = EXCLUDED.wins,
         losses = EXCLUDED.losses, draws = EXCLUDED.draws`,
      [r.address.toLowerCase(), r.elo, r.games, r.wins, r.losses, r.draws],
    );
  }

  async recordResult(r: MatchResult): Promise<void> {
    await this.db.query(
      `INSERT INTO results (match_id, winner, player0, player1, ts)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (match_id) DO NOTHING`,
      [r.matchId.toString(), r.winner, r.player0.toLowerCase(), r.player1.toLowerCase(), r.timestamp],
    );
  }

  async top(n: number): Promise<PlayerRating[]> {
    const { rows } = await this.db.query("SELECT * FROM ratings ORDER BY elo DESC LIMIT $1", [n]);
    return rows.map(rowToRating);
  }
}
