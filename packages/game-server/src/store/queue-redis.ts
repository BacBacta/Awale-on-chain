// Redis-backed matchmaking queue (P1-4): lets more than one server instance
// share a waiting queue. Waiters live in a sorted set (score = Elo) plus a
// metadata hash; pairing DECISIONS use the same pure pairing-core as the
// in-memory Matchmaker, so both backends agree. The claim is ATOMIC via a Lua
// script that removes both members only if both are still present — so two
// instances proposing the same pair can never both win it (no double pairing).

import { bestMatchFor, orderPair, selectPairings, type PairingOptions, type Waiter, type Pair } from "../pairing-core.js";
import type { Address } from "viem";

/** Minimal ioredis-compatible surface this queue needs (fake-able in tests). */
export interface RedisQueueLike {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  zcard(key: string): Promise<number>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  /** ioredis eval(script, numKeys, ...keysThenArgs). Returns 1 on a won claim. */
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

// Remove BOTH members atomically iff BOTH are still queued. The guard is what
// stops two instances from pairing the same waiter twice.
const CLAIM_LUA = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) and redis.call('ZSCORE', KEYS[1], ARGV[2]) then
  redis.call('ZREM', KEYS[1], ARGV[1], ARGV[2])
  redis.call('HDEL', KEYS[2], ARGV[1], ARGV[2])
  return 1
end
return 0`;

interface StoredWaiter {
  address: Address;
  elo: number;
  enqueuedAt: number;
  sessionPubKey?: Address;
}

export class RedisMatchQueue {
  private readonly zkey: string;
  private readonly hkey: string;

  constructor(
    private readonly redis: RedisQueueLike,
    poolKey: string,
    private readonly opts: PairingOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.zkey = `awale:q:${poolKey}`;
    this.hkey = `awale:q:${poolKey}:h`;
  }

  private toWaiter(id: string, raw: string): Waiter {
    const s = JSON.parse(raw) as StoredWaiter;
    return { id, address: s.address, elo: s.elo, enqueuedAt: s.enqueuedAt, sessionPubKey: s.sessionPubKey };
  }

  private async loadAll(): Promise<Waiter[]> {
    const meta = await this.redis.hgetall(this.hkey);
    return Object.entries(meta).map(([id, raw]) => this.toWaiter(id, raw));
  }

  private async writeWaiter(w: Waiter): Promise<void> {
    const stored: StoredWaiter = { address: w.address, elo: w.elo, enqueuedAt: w.enqueuedAt, sessionPubKey: w.sessionPubKey };
    await this.redis.hset(this.hkey, w.id, JSON.stringify(stored));
    await this.redis.zadd(this.zkey, w.elo, w.id);
  }

  /** Atomically claim a candidate pair. Only the instance whose call finds both
   *  still queued wins (returns the ordered Pair); the loser gets null. */
  private async claim(a: Waiter, b: Waiter): Promise<Pair | null> {
    const won = await this.redis.eval(CLAIM_LUA, 2, this.zkey, this.hkey, a.id, b.id);
    return Number(won) === 1 ? orderPair(a, b) : null;
  }

  async size(): Promise<number> {
    return this.redis.zcard(this.zkey);
  }

  async remove(id: string): Promise<void> {
    await this.redis.zrem(this.zkey, id);
    await this.redis.hdel(this.hkey, id);
  }

  /** Add a waiter, then try to pair them with the closest acceptable waiter.
   *  Returns the pairing if the atomic claim succeeds, else null (they wait). */
  async enqueue(player: Omit<Waiter, "enqueuedAt"> & { enqueuedAt?: number }): Promise<Pair | null> {
    const p: Waiter = { ...player, enqueuedAt: player.enqueuedAt ?? this.now() };
    await this.writeWaiter(p);
    const others = (await this.loadAll()).filter((w) => w.id !== p.id);
    const match = bestMatchFor(p, others, this.opts, this.now());
    if (!match) return null;
    return this.claim(p, match);
  }

  /** Pair every compatible waiter, claiming each pair atomically. Pairs whose
   *  claim is lost to another instance are simply skipped this round. */
  async sweep(): Promise<Pair[]> {
    const waiters = await this.loadAll();
    const proposed = selectPairings(waiters, this.opts, this.now());
    const claimed: Pair[] = [];
    for (const pair of proposed) {
      const won = await this.claim(pair.a, pair.b);
      if (won) claimed.push(won);
    }
    return claimed;
  }
}
