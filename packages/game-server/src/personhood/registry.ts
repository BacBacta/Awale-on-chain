import type { Address } from "viem";
import type { PersonhoodRegistry } from "./types.js";
import type { RedisLike } from "../persistence/redis-store.js";

/** In-memory registry — default for dev and the basis for tests. A durable
 *  deployment backs this with the LeaderboardStore's database. */
export class InMemoryPersonhoodRegistry implements PersonhoodRegistry {
  private readonly verified = new Map<string, string>(); // address -> nullifier
  private readonly owners = new Map<string, Address>(); // nullifier -> address

  async isVerified(address: Address): Promise<boolean> {
    return this.verified.has(address.toLowerCase());
  }
  async nullifierOwner(nullifier: string): Promise<Address | null> {
    return this.owners.get(nullifier) ?? null;
  }
  async register(address: Address, nullifier: string): Promise<void> {
    this.verified.set(address.toLowerCase(), nullifier);
    if (!this.owners.has(nullifier)) this.owners.set(nullifier, address);
  }
}

const addrKey = (a: Address) => `awale:person:addr:${a.toLowerCase()}`;
const nullKey = (n: string) => `awale:person:null:${n}`;

/** Redis-backed registry: a verification must outlive a deploy — asking a
 *  human to re-prove they're human after every server restart is the fastest
 *  way to make them stop bothering. */
export class RedisPersonhoodRegistry implements PersonhoodRegistry {
  constructor(private readonly redis: RedisLike) {}

  async isVerified(address: Address): Promise<boolean> {
    return (await this.redis.get(addrKey(address))) !== null;
  }
  async nullifierOwner(nullifier: string): Promise<Address | null> {
    return (await this.redis.get(nullKey(nullifier))) as Address | null;
  }
  async register(address: Address, nullifier: string): Promise<void> {
    await this.redis.set(addrKey(address), nullifier);
    if ((await this.redis.get(nullKey(nullifier))) === null) await this.redis.set(nullKey(nullifier), address);
  }
}
