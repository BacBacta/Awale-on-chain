// Phone-first name service.
//
// Resolution is done on the backend (ODIS quota + signer keys never reach the
// WebView). This module is the transport-agnostic, cached core: a NameResolver
// (the ODIS + FederatedAttestations integration) is injected; the service adds
// a TTL cache and input normalisation, and exposes a lookup handler the HTTP
// layer can call. The front formats the result (mask/short-address); the server
// only returns the raw identity data.

import type { Address } from "viem";
import { normalizePhone } from "./phone.js";

/** The ODIS / FederatedAttestations integration (production impl injected). */
export interface NameResolver {
  /** phone (E.164) -> the address that registered it, or null. */
  resolveByPhone(e164: string): Promise<Address | null>;
  /** address -> E.164 numbers attested to it (via the MiniPay issuer). */
  attestationsFor(address: Address): Promise<string[]>;
}

export interface NameResult {
  address: Address;
  phones: string[];
  attested: boolean;
}

interface CacheEntry<T> {
  value: T;
  expires: number;
}

export interface NameServiceOptions {
  ttlMs?: number;
  now?: () => number;
}

export class CachedNameService {
  private readonly byPhone = new Map<string, CacheEntry<Address | null>>();
  private readonly byAddress = new Map<string, CacheEntry<string[]>>();
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(
    private readonly resolver: NameResolver,
    opts: NameServiceOptions = {},
  ) {
    this.ttl = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async resolveByPhone(rawPhone: string): Promise<Address | null> {
    const phone = normalizePhone(rawPhone);
    const hit = this.byPhone.get(phone);
    if (hit && hit.expires > this.now()) return hit.value;
    const value = await this.resolver.resolveByPhone(phone);
    this.byPhone.set(phone, { value, expires: this.now() + this.ttl });
    return value;
  }

  async lookup(address: Address): Promise<NameResult> {
    const key = address.toLowerCase();
    const hit = this.byAddress.get(key);
    const phones = hit && hit.expires > this.now() ? hit.value : await this.fetchAttestations(address, key);
    return { address, phones, attested: phones.length > 0 };
  }

  private async fetchAttestations(address: Address, key: string): Promise<string[]> {
    const phones = await this.resolver.attestationsFor(address);
    this.byAddress.set(key, { value: phones, expires: this.now() + this.ttl });
    return phones;
  }
}

/** Framework-agnostic handler for `GET /names/:address`. */
export function nameLookupHandler(service: CachedNameService) {
  return (address: Address): Promise<NameResult> => service.lookup(address);
}
