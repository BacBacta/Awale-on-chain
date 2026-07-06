// Pending league prizes — the claim ledger behind "Collect your prize".
//
// The weekly rollover CREDITS winners here instead of pushing a transfer;
// the money moves only when the player taps Collect in the app (a claim is
// a celebration moment, and it brings the winner back into the app). The
// store must be durable (Redis in production): a credited prize is a debt.
//
// take() removes the pending list before the transfer is attempted; a failed
// transfer restores it. Combined with the caller's per-address in-flight
// lock, a double-tap can't be paid twice.

import type { Address } from "viem";
import type { RedisLike } from "./persistence/redis-store.js";

export interface PendingPrize {
  /** Monday key of the week that was won (YYYY-MM-DD). */
  week: string;
  token: Address;
  amountWei: string;
  /** Final rank that earned it — lets the UI say "you finished #4". */
  rank: number;
}

export interface LeaguePrizeStore {
  credit(address: Address, prize: PendingPrize): Promise<void>;
  pending(address: Address): Promise<PendingPrize[]>;
  /** Atomically remove and return everything pending for `address`. */
  take(address: Address): Promise<PendingPrize[]>;
  /** Put prizes back after a failed transfer — a credited prize is a debt. */
  restore(address: Address, prizes: PendingPrize[]): Promise<void>;
}

export class InMemoryLeaguePrizeStore implements LeaguePrizeStore {
  private readonly byAddr = new Map<string, PendingPrize[]>();

  async credit(address: Address, prize: PendingPrize): Promise<void> {
    const k = address.toLowerCase();
    this.byAddr.set(k, [...(this.byAddr.get(k) ?? []), prize]);
  }
  async pending(address: Address): Promise<PendingPrize[]> {
    return [...(this.byAddr.get(address.toLowerCase()) ?? [])];
  }
  async take(address: Address): Promise<PendingPrize[]> {
    const k = address.toLowerCase();
    const out = this.byAddr.get(k) ?? [];
    this.byAddr.delete(k);
    return out;
  }
  async restore(address: Address, prizes: PendingPrize[]): Promise<void> {
    if (prizes.length === 0) return;
    const k = address.toLowerCase();
    this.byAddr.set(k, [...prizes, ...(this.byAddr.get(k) ?? [])]);
  }
}

const KEY = (addr: string) => `awale:league:pending:${addr}`;

export class RedisLeaguePrizeStore implements LeaguePrizeStore {
  constructor(private readonly redis: RedisLike) {}

  private async read(addr: string): Promise<PendingPrize[]> {
    const raw = await this.redis.get(KEY(addr));
    if (!raw) return [];
    try {
      return JSON.parse(raw) as PendingPrize[];
    } catch {
      return [];
    }
  }

  async credit(address: Address, prize: PendingPrize): Promise<void> {
    const k = address.toLowerCase();
    const cur = await this.read(k);
    await this.redis.set(KEY(k), JSON.stringify([...cur, prize]));
  }
  async pending(address: Address): Promise<PendingPrize[]> {
    return this.read(address.toLowerCase());
  }
  async take(address: Address): Promise<PendingPrize[]> {
    const k = address.toLowerCase();
    const out = await this.read(k);
    if (out.length > 0) await this.redis.del(KEY(k));
    return out;
  }
  async restore(address: Address, prizes: PendingPrize[]): Promise<void> {
    if (prizes.length === 0) return;
    const k = address.toLowerCase();
    const cur = await this.read(k);
    await this.redis.set(KEY(k), JSON.stringify([...prizes, ...cur]));
  }
}
