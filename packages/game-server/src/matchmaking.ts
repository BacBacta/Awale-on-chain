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
  /** Backstop so fairness degrades to LIQUIDITY, never deadlock: once a waiter
   *  has waited this long, it may be paired regardless of Elo gap. 0 = never
   *  (the historical behaviour; a lone waiter can wait forever). Cash/ranked
   *  pools set this so a thin player base still eventually gets a game. */
  pairAnyoneAfterSec?: number;
  now?: () => number; // injectable clock for testing
}

export class Matchmaker {
  private readonly waiting: Player[] = [];
  private readonly baseWindow: number;
  private readonly growth: number;
  private readonly pairAnyoneAfterSec: number;
  private readonly now: () => number;

  constructor(opts: MatchmakerOptions = {}) {
    this.baseWindow = opts.baseWindow ?? 100;
    this.growth = opts.windowGrowthPerSec ?? 10;
    this.pairAnyoneAfterSec = opts.pairAnyoneAfterSec ?? 0;
    this.now = opts.now ?? Date.now;
  }

  get queueSize(): number {
    return this.waiting.length;
  }

  private waitedSec(p: Player): number {
    return Math.max(0, (this.now() - p.enqueuedAt) / 1000);
  }

  /** Acceptable Elo gap for a player given how long they've waited. */
  private window(p: Player): number {
    return this.baseWindow + this.growth * this.waitedSec(p);
  }

  /** Whether two waiters may be paired given their gap and how long each waited.
   *  Single source of truth for both `enqueue` and `sweep`. Lenient (the
   *  historical rule): a pair is fine if it fits EITHER widened window.
   *  (P1-6 will make this pluggable strict/lenient.) The pairAnyoneAfterSec
   *  backstop overrides the gap once either side has waited long enough — so a
   *  thin cash pool degrades to liquidity instead of deadlocking. */
  private accepts(gap: number, a: Player, b: Player): boolean {
    if (this.pairAnyoneAfterSec > 0 && Math.max(this.waitedSec(a), this.waitedSec(b)) >= this.pairAnyoneAfterSec) {
      return true;
    }
    return gap <= Math.max(this.window(a), this.window(b));
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
      // never pair a wallet with itself (two tabs/devices): a self-match is
      // free wins, and wins feed the ladder, the quests and the season split
      if (w.address.toLowerCase() === p.address.toLowerCase()) continue;
      const gap = Math.abs(w.elo - p.elo);
      if (this.accepts(gap, p, w) && gap < bestGap) {
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

  /**
   * Pair every currently-compatible waiter, closest-gap-first. This is what
   * makes two *already-waiting* players match once their widening windows
   * overlap — `enqueue` only ever compares the new arrival against waiters, so
   * without this a third arrival was needed to unstick a compatible pair (the
   * bug this fixes). Pure: pass a clock via `MatchmakerOptions.now` to test
   * without real time.
   *
   * Deterministic on ties so two server instances (or a test re-run) produce
   * the same pairings: candidate pairs are ordered by gap, then by the earlier
   * `enqueuedAt`, then lexicographically by address — never by array/index
   * position, which is insertion-order-dependent.
   */
  sweep(): Pairing[] {
    // all compatible unordered pairs, each scored for deterministic ordering
    const candidates: { i: number; j: number; gap: number; key: string }[] = [];
    for (let i = 0; i < this.waiting.length; i++) {
      for (let j = i + 1; j < this.waiting.length; j++) {
        const a = this.waiting[i];
        const b = this.waiting[j];
        if (a.address.toLowerCase() === b.address.toLowerCase()) continue; // no self-match
        const gap = Math.abs(a.elo - b.elo);
        if (!this.accepts(gap, a, b)) continue;
        const earliest = Math.min(a.enqueuedAt, b.enqueuedAt);
        const addrs = [a.address.toLowerCase(), b.address.toLowerCase()].sort();
        candidates.push({ i, j, gap, key: `${earliest}|${addrs[0]}|${addrs[1]}` });
      }
    }
    candidates.sort((x, y) => x.gap - y.gap || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));

    const used = new Set<number>();
    const pairings: Pairing[] = [];
    for (const c of candidates) {
      if (used.has(c.i) || used.has(c.j)) continue;
      used.add(c.i);
      used.add(c.j);
      // earlier waiter is `a` (the creator, in the cash choreography); ties by address
      const [a, b] =
        this.waiting[c.i].enqueuedAt < this.waiting[c.j].enqueuedAt ||
        (this.waiting[c.i].enqueuedAt === this.waiting[c.j].enqueuedAt &&
          this.waiting[c.i].address.toLowerCase() < this.waiting[c.j].address.toLowerCase())
          ? [this.waiting[c.i], this.waiting[c.j]]
          : [this.waiting[c.j], this.waiting[c.i]];
      pairings.push({ a, b });
    }

    if (used.size > 0) {
      // remove all matched waiters in one pass (indices stay valid: filter, don't splice)
      const survivors = this.waiting.filter((_, idx) => !used.has(idx));
      this.waiting.length = 0;
      this.waiting.push(...survivors);
    }
    return pairings;
  }

  /** Remove a player from the queue (e.g. on disconnect). */
  remove(id: string): boolean {
    const i = this.waiting.findIndex((w) => w.id === id);
    if (i < 0) return false;
    this.waiting.splice(i, 1);
    return true;
  }
}
