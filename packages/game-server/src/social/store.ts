// Durable social graph (friends + challenge inbox), keyed by the player's stable
// wallet address — the cross-device identity casual session keys can't provide.
// In-memory by default; RedisSocialStore makes it survive restarts and shared
// across machines (same RedisLike as the match store).

import type { Address } from "viem";
import type { RedisLike } from "../persistence/redis-store.js";

export interface Challenge {
  id: string;
  from: Address;
  matchId: string;
  createdAt: number;
}

export interface SocialStore {
  befriend(a: Address, b: Address): Promise<void>; // mutual
  friends(a: Address): Promise<Address[]>;
  addChallenge(to: Address, c: Challenge): Promise<void>;
  challenges(to: Address): Promise<Challenge[]>;
  removeChallenge(to: Address, id: string): Promise<void>;
}

export class InMemorySocialStore implements SocialStore {
  private fr = new Map<string, Set<string>>();
  private ch = new Map<string, Challenge[]>();
  private k(a: Address) {
    return a.toLowerCase();
  }
  async befriend(a: Address, b: Address) {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const s = this.fr.get(this.k(x)) ?? new Set();
      s.add(y.toLowerCase());
      this.fr.set(this.k(x), s);
    }
  }
  async friends(a: Address) {
    return [...(this.fr.get(this.k(a)) ?? [])] as Address[];
  }
  async addChallenge(to: Address, c: Challenge) {
    const list = (this.ch.get(this.k(to)) ?? []).filter((x) => x.matchId !== c.matchId);
    list.unshift(c);
    this.ch.set(this.k(to), list.slice(0, 50));
  }
  async challenges(to: Address) {
    return this.ch.get(this.k(to)) ?? [];
  }
  async removeChallenge(to: Address, id: string) {
    this.ch.set(this.k(to), (this.ch.get(this.k(to)) ?? []).filter((c) => c.id !== id));
  }
}

const frKey = (a: Address) => `awale:fr:${a.toLowerCase()}`;
const chKey = (a: Address) => `awale:ch:${a.toLowerCase()}`;

/** Redis-backed: friends as a SET, the challenge inbox as a JSON blob. */
export class RedisSocialStore implements SocialStore {
  constructor(private readonly redis: RedisLike) {}
  async befriend(a: Address, b: Address) {
    await this.redis.sadd(frKey(a), b.toLowerCase());
    await this.redis.sadd(frKey(b), a.toLowerCase());
  }
  async friends(a: Address) {
    return (await this.redis.smembers(frKey(a))) as Address[];
  }
  async addChallenge(to: Address, c: Challenge) {
    const list = (await this.challenges(to)).filter((x) => x.matchId !== c.matchId);
    list.unshift(c);
    await this.redis.set(chKey(to), JSON.stringify(list.slice(0, 50)));
  }
  async challenges(to: Address) {
    const raw = await this.redis.get(chKey(to));
    return raw ? (JSON.parse(raw) as Challenge[]) : [];
  }
  async removeChallenge(to: Address, id: string) {
    const list = (await this.challenges(to)).filter((c) => c.id !== id);
    await this.redis.set(chKey(to), JSON.stringify(list));
  }
}
