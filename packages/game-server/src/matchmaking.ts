// Simple in-memory Elo matchmaking queue.
//
// Players join the queue; a new joiner is paired with the closest-rated waiting
// player within a rating window (which widens with wait time). Persistence and
// distribution (Redis) are integration concerns layered on top of this logic.

import type { Address } from "viem";

export interface Player {
  id: string; // wallet or session id
  address: Address;
  elo: number;
  enqueuedAt: number; // ms epoch
  sessionPubKey?: Address; // per-match session key for casual quick-match play
}

export interface Pairing {
  a: Player;
  b: Player;
}

export interface MatchmakerOptions {
  baseWindow?: number; // initial acceptable Elo gap
  windowGrowthPerSec?: number; // how much the window widens per second waited
  now?: () => number; // injectable clock for testing
}

export class Matchmaker {
  private readonly waiting: Player[] = [];
  private readonly baseWindow: number;
  private readonly growth: number;
  private readonly now: () => number;

  constructor(opts: MatchmakerOptions = {}) {
    this.baseWindow = opts.baseWindow ?? 100;
    this.growth = opts.windowGrowthPerSec ?? 10;
    this.now = opts.now ?? Date.now;
  }

  get queueSize(): number {
    return this.waiting.length;
  }

  /** Acceptable Elo gap for a player given how long they've waited. */
  private window(p: Player): number {
    const waitedSec = Math.max(0, (this.now() - p.enqueuedAt) / 1000);
    return this.baseWindow + this.growth * waitedSec;
  }

  /**
   * Enqueue a player. Returns a Pairing if they match an existing waiter
   * (closest Elo within both players' windows), otherwise null (they wait).
   */
  enqueue(player: Omit<Player, "enqueuedAt"> & { enqueuedAt?: number }): Pairing | null {
    const p: Player = { ...player, enqueuedAt: player.enqueuedAt ?? this.now() };

    let bestIdx = -1;
    let bestGap = Infinity;
    for (let i = 0; i < this.waiting.length; i++) {
      const w = this.waiting[i];
      const gap = Math.abs(w.elo - p.elo);
      // a match is acceptable if it fits either player's (wait-widened) window
      if (gap <= Math.max(this.window(p), this.window(w)) && gap < bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      const [b] = this.waiting.splice(bestIdx, 1);
      return { a: p, b };
    }

    this.waiting.push(p);
    return null;
  }

  /** Remove a player from the queue (e.g. on disconnect). */
  remove(id: string): boolean {
    const i = this.waiting.findIndex((w) => w.id === id);
    if (i < 0) return false;
    this.waiting.splice(i, 1);
    return true;
  }
}
