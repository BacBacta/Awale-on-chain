// Redis-backed live match store. Takes a minimal client interface (satisfied by
// ioredis / node-redis) so the package needs no driver dependency and the
// adapter is testable with a fake.

import type { MatchSnapshot } from "../match.js";
import type { LiveMatchStore } from "./types.js";
import { snapshotToJson, snapshotFromJson } from "./serialize.js";

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
}

const PREFIX = "awale:match:";

export class RedisLiveMatchStore implements LiveMatchStore {
  constructor(private readonly redis: RedisLike) {}

  private key(matchId: bigint): string {
    return `${PREFIX}${matchId.toString()}`;
  }

  async save(snap: MatchSnapshot): Promise<void> {
    await this.redis.set(this.key(snap.matchId), snapshotToJson(snap));
  }
  async load(matchId: bigint): Promise<MatchSnapshot | null> {
    const raw = await this.redis.get(this.key(matchId));
    return raw ? snapshotFromJson(raw) : null;
  }
  async remove(matchId: bigint): Promise<void> {
    await this.redis.del(this.key(matchId));
  }
  async list(): Promise<bigint[]> {
    const keys = await this.redis.keys(`${PREFIX}*`);
    return keys.map((k) => BigInt(k.slice(PREFIX.length)));
  }
}
