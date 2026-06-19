// Postgres-backed personhood registry — durable across server restarts,
// unlike InMemoryPersonhoodRegistry. Same minimal PgLike interface as
// store/postgres.ts (satisfied by `pg`'s Pool) so this package needs no
// driver dependency of its own.

import type { Address } from "viem";
import type { PersonhoodRegistry } from "./types.js";
import type { PgLike } from "../store/postgres.js";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS personhood (
  address    TEXT PRIMARY KEY,
  nullifier  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS personhood_nullifier_idx ON personhood (nullifier);
`;

export class PgPersonhoodRegistry implements PersonhoodRegistry {
  constructor(private readonly db: PgLike) {}

  async isVerified(address: Address): Promise<boolean> {
    const { rows } = await this.db.query("SELECT 1 FROM personhood WHERE address = $1", [
      address.toLowerCase(),
    ]);
    return rows.length > 0;
  }

  async nullifierOwner(nullifier: string): Promise<Address | null> {
    const { rows } = await this.db.query(
      "SELECT address FROM personhood WHERE nullifier = $1 ORDER BY address LIMIT 1",
      [nullifier],
    );
    return rows[0] ? (rows[0].address as Address) : null;
  }

  async register(address: Address, nullifier: string): Promise<void> {
    await this.db.query(
      `INSERT INTO personhood (address, nullifier) VALUES ($1, $2)
       ON CONFLICT (address) DO UPDATE SET nullifier = EXCLUDED.nullifier`,
      [address.toLowerCase(), nullifier],
    );
  }
}
