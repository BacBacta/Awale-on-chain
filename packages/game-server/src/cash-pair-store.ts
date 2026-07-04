// Persistence for half-built cash pairs (P1-4). A "cash pair" is the window
// between two players being matched for money and both stakes landing on-chain
// — the creator may already have staked. If the server restarts in that
// window, the in-memory pair is lost and the creator's stake would sit in an
// Open match with nobody choreographing a refund. Persisting the pair lets the
// boot path re-find it and cleanly ABORT it, so the creator's client auto-
// cancels for a refund (its existing cash-abort handler) — money is never
// stranded by a deploy.
//
// Keyed by the CREATOR'S ADDRESS, not the socket id: socket ids die with the
// process, addresses survive, and the creator reconnects under the same wallet.

import type { Address } from "viem";

export interface PersistedCashPair {
  creator: Address;
  joiner: Address;
  stakeKey: string; // `${token}:${resolvedStakeWei}`
  matchId?: string; // set once the creator's match is created on-chain
  createdAt: number;
}

export interface CashPairStore {
  put(pair: PersistedCashPair): Promise<void>;
  remove(creator: Address): Promise<void>;
  list(): Promise<PersistedCashPair[]>;
}

export class InMemoryCashPairStore implements CashPairStore {
  private readonly map = new Map<string, PersistedCashPair>();
  async put(pair: PersistedCashPair): Promise<void> {
    this.map.set(pair.creator.toLowerCase(), pair);
  }
  async remove(creator: Address): Promise<void> {
    this.map.delete(creator.toLowerCase());
  }
  async list(): Promise<PersistedCashPair[]> {
    return [...this.map.values()];
  }
}

/** Minimal ioredis surface for the cash-pair hash (fake-able in tests). */
export interface CashPairRedisLike {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
}

const HKEY = "awale:cashpairs";

export class RedisCashPairStore implements CashPairStore {
  constructor(private readonly redis: CashPairRedisLike) {}
  async put(pair: PersistedCashPair): Promise<void> {
    await this.redis.hset(HKEY, pair.creator.toLowerCase(), JSON.stringify(pair));
  }
  async remove(creator: Address): Promise<void> {
    await this.redis.hdel(HKEY, creator.toLowerCase());
  }
  async list(): Promise<PersistedCashPair[]> {
    const all = await this.redis.hgetall(HKEY);
    return Object.values(all).map((raw) => JSON.parse(raw) as PersistedCashPair);
  }
}

/**
 * Boot recovery: for every cash pair persisted before the restart, notify both
 * players to abort (so the creator's client auto-cancels its stake for a
 * refund) and clear the record. Mirrors keeper.ts re-arming on-chain timeouts
 * on boot. `notifyAbort(pair)` does the transport (emit cash-abort to a room /
 * per-address channel); returning here just means the record is cleared.
 */
export async function recoverCashPairs(
  store: CashPairStore,
  notifyAbort: (pair: PersistedCashPair) => void,
): Promise<number> {
  const pairs = await store.list();
  for (const pair of pairs) {
    notifyAbort(pair);
    await store.remove(pair.creator);
  }
  return pairs.length;
}
