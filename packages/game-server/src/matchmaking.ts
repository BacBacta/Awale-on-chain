// In-memory Elo matchmaking queue. The pairing DECISIONS live in the pure
// pairing-core module (shared with the Redis-backed distributed queue); this
// class is just the in-memory storage + the injectable clock around them.

import { bestMatchFor, selectPairings, type PairingOptions, type Waiter, type Pair } from "./pairing-core.js";

// Kept as the public names this module has always exported.
export type Player = Waiter;
export type Pairing = Pair;

export interface MatchmakerOptions {
  baseWindow?: number; // initial acceptable Elo gap
  windowGrowthPerSec?: number; // how much the window widens per second waited
  /** Backstop so fairness degrades to LIQUIDITY, never deadlock: once a waiter
   *  has waited this long, it may be paired regardless of Elo gap. 0 = never
   *  (a lone waiter can wait forever). Cash/ranked pools set this. */
  pairAnyoneAfterSec?: number;
  /** "lenient" (default, casual) pairs if EITHER window covers the gap;
   *  "strict" (ranked/cash, P1-6) requires BOTH. */
  windowRule?: "strict" | "lenient";
  /** Hard Elo-gap ceiling the window/backstop can never exceed — the anti-churn
   *  guard for money play (no shark-vs-fish). Omit = no ceiling (casual). */
  maxGap?: number;
  now?: () => number; // injectable clock for testing
}

export class Matchmaker {
  private readonly waiting: Player[] = [];
  private readonly opts: PairingOptions;
  private readonly now: () => number;

  constructor(opts: MatchmakerOptions = {}) {
    this.opts = {
      baseWindow: opts.baseWindow ?? 100,
      growth: opts.windowGrowthPerSec ?? 10,
      pairAnyoneAfterSec: opts.pairAnyoneAfterSec ?? 0,
      windowRule: opts.windowRule ?? "lenient",
      maxGap: opts.maxGap ?? Infinity,
    };
    this.now = opts.now ?? Date.now;
  }

  get queueSize(): number {
    return this.waiting.length;
  }

  /**
   * Enqueue a player. Returns a Pairing if they match an existing waiter
   * (closest Elo within the acceptance rule), otherwise null (they wait).
   */
  enqueue(player: Omit<Player, "enqueuedAt"> & { enqueuedAt?: number }): Pairing | null {
    const p: Player = { ...player, enqueuedAt: player.enqueuedAt ?? this.now() };
    const match = bestMatchFor(p, this.waiting, this.opts, this.now());
    if (match) {
      this.waiting.splice(this.waiting.indexOf(match), 1);
      return { a: p, b: match };
    }
    this.waiting.push(p);
    return null;
  }

  /**
   * Pair every currently-compatible waiter, closest-gap-first. This is what
   * makes two ALREADY-waiting players match once their windows overlap —
   * enqueue only ever compares the new arrival against waiters, so without
   * this a third arrival was needed to unstick a compatible pair (P0-1).
   * Deterministic on ties (earliest enqueue, then address) so instances /
   * re-runs agree.
   */
  sweep(): Pairing[] {
    const pairs = selectPairings(this.waiting, this.opts, this.now());
    if (pairs.length > 0) {
      const matched = new Set<string>();
      for (const p of pairs) {
        matched.add(p.a.id);
        matched.add(p.b.id);
      }
      const survivors = this.waiting.filter((w) => !matched.has(w.id));
      this.waiting.length = 0;
      this.waiting.push(...survivors);
    }
    return pairs;
  }

  /** Remove a player from the queue (e.g. on disconnect). */
  remove(id: string): boolean {
    const i = this.waiting.findIndex((w) => w.id === id);
    if (i < 0) return false;
    this.waiting.splice(i, 1);
    return true;
  }
}
