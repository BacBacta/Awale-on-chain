import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { createOdisResolver, type OdisDeps } from "../src/identity/odis.js";

const ALICE = "0x00000000000000000000000000000000000000a1" as Address;

// mock the injected @celo/identity plumbing — the resolver logic is what we test
function mockDeps(over: Partial<OdisDeps> = {}): OdisDeps {
  return {
    obfuscate: async (e164) => `id:${e164}`,
    lookupAccounts: async (id) => (id === "id:+15551234567" ? [ALICE] : []),
    lookupIdentifiers: async (addr) => (addr === ALICE ? ["id:+15551234567"] : []),
    ...over,
  };
}

describe("createOdisResolver", () => {
  it("resolveByPhone: obfuscate → lookupAccounts → the registered address", async () => {
    const r = createOdisResolver(mockDeps());
    expect(await r.resolveByPhone("+15551234567")).toBe(ALICE);
    expect(await r.resolveByPhone("+10000000000")).toBeNull(); // no attestation
  });

  it("attestationsFor: returns the (opaque) identifiers — presence = verified", async () => {
    const r = createOdisResolver(mockDeps());
    expect(await r.attestationsFor(ALICE)).toHaveLength(1);
    expect(await r.attestationsFor("0x00000000000000000000000000000000000000b2" as Address)).toEqual([]);
  });

  it("a lookup failure degrades to an absent name, never a throw", async () => {
    const r = createOdisResolver(
      mockDeps({
        obfuscate: async () => {
          throw new Error("odis quota exhausted");
        },
        lookupIdentifiers: async () => {
          throw new Error("rpc down");
        },
      }),
    );
    expect(await r.resolveByPhone("+15551234567")).toBeNull();
    expect(await r.attestationsFor(ALICE)).toEqual([]);
  });
});
