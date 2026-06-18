import type { Address } from "viem";
import type { PersonhoodRegistry } from "./types.js";

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
