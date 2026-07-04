// Pure pairing decision logic, shared by the in-memory Matchmaker and the
// Redis-backed distributed queue (P1-4). No storage, no clock of its own — a
// clock is passed in — so it unit-tests without timers or Redis and both
// backends make identical decisions.

import type { Address } from "viem";

export interface Waiter {
  id: string; // socket id / session id
  address: Address;
  elo: number;
  enqueuedAt: number; // ms epoch
  sessionPubKey?: Address; // per-match session key for casual quick-match play
}

export interface Pair {
  a: Waiter;
  b: Waiter;
}

/** How the widened window is applied when two players' windows differ:
 *  - "lenient": pair if EITHER window covers the gap (speed over fairness) —
 *    the historical casual rule.
 *  - "strict":  pair only if BOTH windows cover the gap, so a fresh player is
 *    never dragged into a huge gap just because the OTHER side waited long
 *    (used for ranked/cash — P1-6). */
export type WindowRule = "strict" | "lenient";

export interface PairingOptions {
  baseWindow: number;
  growth: number; // window widening per second waited
  pairAnyoneAfterSec: number; // 0 = never; else gap ignored past this wait
  windowRule: WindowRule;
}

export function waitedSec(w: Waiter, now: number): number {
  return Math.max(0, (now - w.enqueuedAt) / 1000);
}

export function windowOf(w: Waiter, opts: PairingOptions, now: number): number {
  return opts.baseWindow + opts.growth * waitedSec(w, now);
}

/** Whether two waiters may be paired. Single source of truth. */
export function accepts(a: Waiter, b: Waiter, opts: PairingOptions, now: number): boolean {
  if (a.address.toLowerCase() === b.address.toLowerCase()) return false; // no self-match
  if (opts.pairAnyoneAfterSec > 0 && Math.max(waitedSec(a, now), waitedSec(b, now)) >= opts.pairAnyoneAfterSec) {
    return true; // liquidity backstop overrides the gap
  }
  const gap = Math.abs(a.elo - b.elo);
  const wa = windowOf(a, opts, now);
  const wb = windowOf(b, opts, now);
  return opts.windowRule === "strict" ? gap <= Math.min(wa, wb) : gap <= Math.max(wa, wb);
}

/** The closest acceptable waiter for a newcomer `p` (enqueue path). */
export function bestMatchFor(p: Waiter, waiters: readonly Waiter[], opts: PairingOptions, now: number): Waiter | null {
  let best: Waiter | null = null;
  let bestGap = Infinity;
  for (const w of waiters) {
    if (!accepts(p, w, opts, now)) continue;
    const gap = Math.abs(w.elo - p.elo);
    if (gap < bestGap) {
      bestGap = gap;
      best = w;
    }
  }
  return best;
}

/** Deterministic ordering key for a candidate pair: earliest enqueue, then the
 *  sorted address pair — never insertion order, so two instances / a re-run
 *  agree. */
function pairKey(a: Waiter, b: Waiter): string {
  const earliest = Math.min(a.enqueuedAt, b.enqueuedAt);
  const addrs = [a.address.toLowerCase(), b.address.toLowerCase()].sort();
  return `${earliest}|${addrs[0]}|${addrs[1]}`;
}

/** Order two waiters so the EARLIER one is `a` (the cash creator); ties by
 *  lower address. */
export function orderPair(x: Waiter, y: Waiter): Pair {
  const xFirst =
    x.enqueuedAt < y.enqueuedAt ||
    (x.enqueuedAt === y.enqueuedAt && x.address.toLowerCase() < y.address.toLowerCase());
  return xFirst ? { a: x, b: y } : { a: y, b: x };
}

/** Pair every currently-compatible waiter, closest-gap-first, deterministic on
 *  ties (sweep path). Returns pairings; the caller removes the matched ids. */
export function selectPairings(waiters: readonly Waiter[], opts: PairingOptions, now: number): Pair[] {
  const candidates: { i: number; j: number; gap: number; key: string }[] = [];
  for (let i = 0; i < waiters.length; i++) {
    for (let j = i + 1; j < waiters.length; j++) {
      const a = waiters[i];
      const b = waiters[j];
      if (!accepts(a, b, opts, now)) continue;
      candidates.push({ i, j, gap: Math.abs(a.elo - b.elo), key: pairKey(a, b) });
    }
  }
  candidates.sort((x, y) => x.gap - y.gap || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));

  const used = new Set<number>();
  const pairs: Pair[] = [];
  for (const c of candidates) {
    if (used.has(c.i) || used.has(c.j)) continue;
    used.add(c.i);
    used.add(c.j);
    pairs.push(orderPair(waiters[c.i], waiters[c.j]));
  }
  return pairs;
}
