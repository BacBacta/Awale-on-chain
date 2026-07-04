// Durable player profile, keyed by wallet address — the cross-device identity
// that localStorage can't provide. The daily streak lived only on the device
// before this: reinstalling MiniPay or clearing the cache silently wiped it,
// punishing exactly the most loyal players. The server is now the source of
// truth; the client's localStorage is just a cache.
//
// Day math is UTC (same convention as the client's daily puzzle key), and the
// streak rule mirrors the client's: alive if last solved today or yesterday.

import type { Address } from "viem";
import { updateEloPair, scoreForWinner, kFactor } from "../elo.js";
import { DEFAULT_ELO } from "../store/types.js";
import type { RedisLike } from "../persistence/redis-store.js";
import type { QuestProgress } from "./quests.js"; // type-only: no runtime cycle

export interface PlayerProfile {
  address: Address;
  /** Consecutive daily-puzzle days as of `lastDailyDone` (may be stale — see liveStreak). */
  streak: number;
  /** UTC YYYY-MM-DD of the last solved daily puzzle; "" if never. */
  lastDailyDone: string;
  lastSeenAt: number; // epoch ms
  gamesPlayed: number;
  gamesWon: number;
  /** Live (blitz/quick-match/cash) skill rating. THE rating used for live +
   *  cash matchmaking and the leaderboard. `elo` mirrors it for backward
   *  compatibility (older readers, the client). */
  eloLive: number;
  /** Correspondence (async/"with a friend at your own pace") skill rating —
   *  kept separate because the two formats reward different skills. */
  eloAsync: number;
  /** Deprecated single rating, kept as a mirror of eloLive so nothing reading
   *  `elo` breaks. Migrated from old records as eloLive (see normalize). */
  elo: number;
  /** Today's daily-quest progress (see profile/quests.ts); rolls over by day. */
  quests: QuestProgress;
  /** Days on which every daily quest was completed. Only ever grows. */
  perfectDays: number;
  /** UTC day a streak-expiry nudge was last sent (dedupe: max one per day). */
  lastStreakNudge: string;
  /** UTC day a your-turn nudge was last sent (dedupe: max one per day). */
  lastTurnNudge: string;
  /** Advisory anti-cheat / moderation flags (P2-7), e.g. "engine-assist".
   *  For human review only — never gates play or money. */
  flags?: string[];
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
    eloLive: DEFAULT_ELO,
    eloAsync: DEFAULT_ELO,
    elo: DEFAULT_ELO,
    quests: { day: "", playGames: 0, winGames: 0, practiceGames: 0, solvedDaily: false, rewarded: false },
    perfectDays: 0,
    lastStreakNudge: "",
    lastTurnNudge: "",
  };
}

/** Fill any fields a record persisted by an older build doesn't have yet. */
function normalize(address: Address, parsed: Partial<PlayerProfile>): PlayerProfile {
  const base = { ...freshProfile(address), lastSeenAt: 0, ...parsed };
  // Migration (P1-5): an old record has a single `elo` and no split pools —
  // seed BOTH pools from it so no rating history is lost.
  if (parsed.eloLive === undefined && typeof parsed.elo === "number") {
    base.eloLive = parsed.elo;
    base.eloAsync = parsed.eloAsync ?? parsed.elo;
  }
  // keep the legacy mirror consistent with the live pool
  base.elo = base.eloLive;
  return base;
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

/**
 * Apply a finished two-player game to both profiles: Elo transfer (in the given
 * pool, with the FIDE-inspired per-player K schedule) plus played/won counters.
 * `winner` uses the engine convention (0, 1, 2 = draw). `pool` routes the rating
 * to eloLive (blitz/quick-match/cash) or eloAsync (correspondence); the legacy
 * `elo` mirror tracks eloLive. Pure — callers load, apply, save.
 */
export function applyGameResult(
  p0: PlayerProfile,
  p1: PlayerProfile,
  winner: number,
  pool: "live" | "async" = "live",
): [PlayerProfile, PlayerProfile] {
  const r0 = pool === "live" ? p0.eloLive : p0.eloAsync;
  const r1 = pool === "live" ? p1.eloLive : p1.eloAsync;
  // K uses each player's own experience + current pool rating
  const [n0, n1] = updateEloPair(r0, r1, scoreForWinner(winner), kFactor(p0.gamesPlayed, r0), kFactor(p1.gamesPlayed, r1));
  const apply = (p: PlayerProfile, newRating: number, won: boolean): PlayerProfile => {
    const updated: PlayerProfile = {
      ...p,
      gamesPlayed: p.gamesPlayed + 1,
      gamesWon: p.gamesWon + (won ? 1 : 0),
      eloLive: pool === "live" ? newRating : p.eloLive,
      eloAsync: pool === "async" ? newRating : p.eloAsync,
      elo: p.elo,
    };
    updated.elo = updated.eloLive; // legacy mirror = live rating
    return updated;
  };
  return [apply(p0, n0, winner === 0), apply(p1, n1, winner === 1)];
}

/** Ranked slice of profiles for the skill leaderboard: players with at least
 *  one game, highest Elo first. Fine to compute by sorting at MiniPay-test
 *  scale; switch the store to a Redis ZSET when the index outgrows this. */
export function topByElo(profiles: PlayerProfile[], n: number): PlayerProfile[] {
  return profiles
    .filter((p) => p.gamesPlayed > 0)
    .sort((a, b) => b.elo - a.elo || b.gamesWon - a.gamesWon)
    .slice(0, n);
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
    const p = this.byAddr.get(address.toLowerCase());
    return p ? normalize(address, p) : null;
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
    return raw ? normalize(address, JSON.parse(raw) as Partial<PlayerProfile>) : null;
  }
  async save(profile: PlayerProfile): Promise<void> {
    await this.redis.set(profKey(profile.address), JSON.stringify(profile));
    await this.redis.sadd(INDEX, profile.address.toLowerCase());
  }
  async list(): Promise<Address[]> {
    return (await this.redis.smembers(INDEX)) as Address[];
  }
}
