// Durable player profile, keyed by wallet address — the cross-device identity
// that localStorage can't provide. The daily streak lived only on the device
// before this: reinstalling MiniPay or clearing the cache silently wiped it,
// punishing exactly the most loyal players. The server is now the source of
// truth; the client's localStorage is just a cache.
//
// Day math is UTC (same convention as the client's daily puzzle key), and the
// streak rule mirrors the client's: alive if last solved today or yesterday.

import type { Address } from "viem";
import type { RedisLike } from "../persistence/redis-store.js";

export interface PlayerProfile {
  address: Address;
  /** Consecutive daily-puzzle days as of `lastDailyDone` (may be stale — see liveStreak). */
  streak: number;
  /** UTC YYYY-MM-DD of the last solved daily puzzle; "" if never. */
  lastDailyDone: string;
  lastSeenAt: number; // epoch ms
  gamesPlayed: number;
  gamesWon: number;
  /** UTC day a streak-expiry nudge was last sent (dedupe: max one per day). */
  lastStreakNudge: string;
  /** UTC day a your-turn nudge was last sent (dedupe: max one per day). */
  lastTurnNudge: string;
}

export function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function prevDayKey(d = new Date()): string {
  return dayKey(new Date(d.getTime() - 86_400_000));
}

export function freshProfile(address: Address): PlayerProfile {
  return {
    address: address.toLowerCase() as Address,
    streak: 0,
    lastDailyDone: "",
    lastSeenAt: Date.now(),
    gamesPlayed: 0,
    gamesWon: 0,
    lastStreakNudge: "",
    lastTurnNudge: "",
  };
}

/** The streak as it stands *right now*: 0 once a day has been missed. */
export function liveStreak(p: Pick<PlayerProfile, "streak" | "lastDailyDone">, now = new Date()): number {
  return p.lastDailyDone === dayKey(now) || p.lastDailyDone === prevDayKey(now) ? p.streak : 0;
}

/** Record today's daily-puzzle solve. Idempotent within a day. */
export function applyDailySolve(p: PlayerProfile, now = new Date()): PlayerProfile {
  const today = dayKey(now);
  if (p.lastDailyDone === today) return p;
  const streak = p.lastDailyDone === prevDayKey(now) ? p.streak + 1 : 1;
  return { ...p, streak, lastDailyDone: today };
}

/**
 * One-time adoption of a device-local streak (the pre-profile world): accepted
 * only while the server has no daily history at all, and only if the local
 * streak is still alive by the same rule the server enforces. Low-stakes by
 * design — the daily puzzle carries no money, so a spoofed count buys nothing
 * but a number on your own screen.
 */
export function migrateLocalStreak(
  p: PlayerProfile,
  local: { count: number; lastDone: string },
  now = new Date(),
): PlayerProfile {
  if (p.lastDailyDone !== "") return p; // server already has history — it wins
  const alive = local.lastDone === dayKey(now) || local.lastDone === prevDayKey(now);
  if (!alive || local.count <= 0) return p;
  return { ...p, streak: Math.floor(local.count), lastDailyDone: local.lastDone };
}

export interface ProfileStore {
  get(address: Address): Promise<PlayerProfile | null>;
  save(profile: PlayerProfile): Promise<void>;
  /** Every address with a profile — the retention sweep iterates this. */
  list(): Promise<Address[]>;
}

export class InMemoryProfileStore implements ProfileStore {
  private readonly byAddr = new Map<string, PlayerProfile>();
  async get(address: Address): Promise<PlayerProfile | null> {
    return this.byAddr.get(address.toLowerCase()) ?? null;
  }
  async save(profile: PlayerProfile): Promise<void> {
    this.byAddr.set(profile.address.toLowerCase(), profile);
  }
  async list(): Promise<Address[]> {
    return [...this.byAddr.keys()] as Address[];
  }
}

const profKey = (a: Address) => `awale:profile:${a.toLowerCase()}`;
const INDEX = "awale:profiles";

export class RedisProfileStore implements ProfileStore {
  constructor(private readonly redis: RedisLike) {}
  async get(address: Address): Promise<PlayerProfile | null> {
    const raw = await this.redis.get(profKey(address));
    return raw ? (JSON.parse(raw) as PlayerProfile) : null;
  }
  async save(profile: PlayerProfile): Promise<void> {
    await this.redis.set(profKey(profile.address), JSON.stringify(profile));
    await this.redis.sadd(INDEX, profile.address.toLowerCase());
  }
  async list(): Promise<Address[]> {
    return (await this.redis.smembers(INDEX)) as Address[];
  }
}
