import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { normalizePhone, isValidE164 } from "../src/identity/phone.js";
import { CachedNameService, nameLookupHandler, type NameResolver } from "../src/identity/names.js";

const ADDR: Address = "0x000000000000000000000000000000000000000a";

describe("phone normalisation", () => {
  it("canonicalises common formats to E.164", () => {
    expect(normalizePhone("+233 20 123 4567")).toBe("+233201234567");
    expect(normalizePhone("+1 (415) 555-0123")).toBe("+14155550123");
  });

  it("rejects non-E.164 input", () => {
    expect(() => normalizePhone("0201234567")).toThrow(); // no country code
    expect(() => normalizePhone("+0123")).toThrow(); // leading 0 / too short
    expect(isValidE164("+233201234567")).toBe(true);
    expect(isValidE164("nope")).toBe(false);
  });
});

describe("CachedNameService", () => {
  function fakeResolver() {
    const calls = { resolve: 0, attest: 0 };
    const resolver: NameResolver = {
      async resolveByPhone() {
        calls.resolve++;
        return ADDR;
      },
      async attestationsFor() {
        calls.attest++;
        return ["+233201234567"];
      },
    };
    return { resolver, calls };
  }

  it("normalises and caches phone resolution within the TTL", async () => {
    let clock = 0;
    const { resolver, calls } = fakeResolver();
    const svc = new CachedNameService(resolver, { ttlMs: 1000, now: () => clock });

    expect(await svc.resolveByPhone("+233 20 123 4567")).toBe(ADDR);
    await svc.resolveByPhone("+233201234567"); // same number, normalised -> cache hit
    expect(calls.resolve).toBe(1);

    clock = 2000; // past TTL
    await svc.resolveByPhone("+233201234567");
    expect(calls.resolve).toBe(2);
  });

  it("looks up attestations and reports attested status", async () => {
    const { resolver, calls } = fakeResolver();
    const svc = new CachedNameService(resolver, { ttlMs: 1000, now: () => 0 });
    const handler = nameLookupHandler(svc);

    const result = await handler(ADDR);
    expect(result).toEqual({ address: ADDR, phones: ["+233201234567"], attested: true });
    await handler(ADDR); // cached
    expect(calls.attest).toBe(1);
  });

  it("reports not-attested for an unknown address", async () => {
    const resolver: NameResolver = {
      async resolveByPhone() {
        return null;
      },
      async attestationsFor() {
        return [];
      },
    };
    const svc = new CachedNameService(resolver);
    const result = await svc.lookup(ADDR);
    expect(result.attested).toBe(false);
    expect(result.phones).toEqual([]);
  });
});
