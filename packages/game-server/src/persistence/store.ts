// Match persistence — the abstraction that makes async / correspondence play
// possible (a match survives both players being offline).
//
// `InMemoryMatchStore` is the default (single-process). Wire `RedisMatchStore`
// (live state, fast) and/or `PostgresMatchStore` (durable history) by
// implementing the same interface — see docs/async-push-milestone.md.

import type { Address } from "viem";
import type { MatchSnapshot } from "../match.js";

export interface MatchRecord {
  /** Engine snapshot (moves + sigs) — replay it to get the live state. */
  snapshot: MatchSnapshot;
  /** Wallet addresses of player 0 and player 1 (for listing & notifications). */
  players: [Address, Address];
  mode: "casual" | "cash";
  /** Denormalised for cheap listing/filtering (kept in sync on each save). */
  turn: number;
  over: boolean;
  ply: number;
  updatedAt: number;
  /** Per-match inactivity-claim window (ms), overriding the global default.
   *  Tournament bracket games run on minutes, not correspondence days. */
  turnClockMs?: number;
}

export interface MatchStore {
  save(rec: MatchRecord): Promise<void>;
  get(matchId: string): Promise<MatchRecord | null>;
  /** A player's matches, newest first. */
  listForPlayer(address: Address): Promise<MatchRecord[]>;
  remove(matchId: string): Promise<void>;
}

/** Default single-process store. Swap for Redis/Postgres in production. */
export class InMemoryMatchStore implements MatchStore {
  private readonly byId = new Map<string, MatchRecord>();
  private readonly byPlayer = new Map<string, Set<string>>(); // address(lc) -> matchIds

  async save(rec: MatchRecord): Promise<void> {
    const id = rec.snapshot.matchId.toString();
    this.byId.set(id, rec);
    for (const p of rec.players) {
      const key = p.toLowerCase();
      let set = this.byPlayer.get(key);
      if (!set) this.byPlayer.set(key, (set = new Set()));
      set.add(id);
    }
  }

  async get(matchId: string): Promise<MatchRecord | null> {
    return this.byId.get(matchId) ?? null;
  }

  async listForPlayer(address: Address): Promise<MatchRecord[]> {
    const ids = this.byPlayer.get(address.toLowerCase());
    if (!ids) return [];
    const out: MatchRecord[] = [];
    for (const id of ids) {
      const rec = this.byId.get(id);
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async remove(matchId: string): Promise<void> {
    const rec = this.byId.get(matchId);
    this.byId.delete(matchId);
    if (rec) for (const p of rec.players) this.byPlayer.get(p.toLowerCase())?.delete(matchId);
  }
}
