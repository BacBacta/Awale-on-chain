// Redis-backed MatchStore — durable async/correspondence matches + scaling past
// a single process (shared state across machines). Implemented against a minimal
// `RedisLike` interface so it's unit-testable with a fake and satisfied by a real
// `ioredis` client in production (see main.ts; activate by setting REDIS_URL).

import type { Address } from "viem";
import type { MatchRecord, MatchStore } from "./store.js";

/** The subset of the redis client this store needs (ioredis-compatible). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
}

const matchKey = (id: string) => `awale:match:${id}`;
const playerKey = (addr: Address) => `awale:player:${addr.toLowerCase()}`;

// MatchRecord's snapshot carries bigints (matchId, chainId) → store them as
// strings and revive on read so JSON round-trips cleanly.
function encode(rec: MatchRecord): string {
  return JSON.stringify({
    ...rec,
    snapshot: { ...rec.snapshot, matchId: rec.snapshot.matchId.toString(), chainId: rec.snapshot.chainId.toString() },
  });
}
function decode(raw: string): MatchRecord {
  const o = JSON.parse(raw) as MatchRecord & { snapshot: { matchId: string; chainId: string } };
  return { ...o, snapshot: { ...o.snapshot, matchId: BigInt(o.snapshot.matchId), chainId: BigInt(o.snapshot.chainId) } };
}

export class RedisMatchStore implements MatchStore {
  constructor(private readonly redis: RedisLike) {}

  async save(rec: MatchRecord): Promise<void> {
    const id = rec.snapshot.matchId.toString();
    await this.redis.set(matchKey(id), encode(rec));
    for (const p of rec.players) await this.redis.sadd(playerKey(p), id);
  }

  async get(matchId: string): Promise<MatchRecord | null> {
    const raw = await this.redis.get(matchKey(matchId));
    return raw ? decode(raw) : null;
  }

  async listForPlayer(address: Address): Promise<MatchRecord[]> {
    const ids = await this.redis.smembers(playerKey(address));
    const out: MatchRecord[] = [];
    for (const id of ids) {
      const raw = await this.redis.get(matchKey(id));
      if (raw) out.push(decode(raw));
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async remove(matchId: string): Promise<void> {
    const rec = await this.get(matchId);
    await this.redis.del(matchKey(matchId));
    if (rec) for (const p of rec.players) await this.redis.srem(playerKey(p), matchId);
  }
}
