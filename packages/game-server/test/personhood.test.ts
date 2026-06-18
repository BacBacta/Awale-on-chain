import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { InMemoryPersonhoodRegistry } from "../src/personhood/registry.js";
import { verifyAndRegister, assertPersonhood } from "../src/personhood/gate.js";
import type { PersonhoodVerifier } from "../src/personhood/types.js";

const A: Address = "0x000000000000000000000000000000000000000a";
const B: Address = "0x000000000000000000000000000000000000000b";

/** Verifier that maps a proof straight to a nullifier (or fails on null). */
const verifier: PersonhoodVerifier = {
  async verify(_address, proof) {
    if (proof === null) return { ok: false };
    return { ok: true, nullifier: String(proof) };
  },
};

describe("verifyAndRegister", () => {
  it("verifies and registers a human", async () => {
    const reg = new InMemoryPersonhoodRegistry();
    const out = await verifyAndRegister(verifier, reg, A, "human-1");
    expect(out.verified).toBe(true);
    expect(await reg.isVerified(A)).toBe(true);
  });

  it("rejects an invalid proof", async () => {
    const reg = new InMemoryPersonhoodRegistry();
    const out = await verifyAndRegister(verifier, reg, A, null);
    expect(out.verified).toBe(false);
    expect(await reg.isVerified(A)).toBe(false);
  });

  it("blocks the same human on a second account (sybil)", async () => {
    const reg = new InMemoryPersonhoodRegistry();
    await verifyAndRegister(verifier, reg, A, "human-1");
    const out = await verifyAndRegister(verifier, reg, B, "human-1"); // same nullifier
    expect(out.verified).toBe(false);
    expect(out.reason).toMatch(/already used/);
    expect(await reg.isVerified(B)).toBe(false);
  });

  it("is idempotent for the same account + nullifier", async () => {
    const reg = new InMemoryPersonhoodRegistry();
    await verifyAndRegister(verifier, reg, A, "human-1");
    const again = await verifyAndRegister(verifier, reg, A, "human-1");
    expect(again.verified).toBe(true);
  });
});

describe("assertPersonhood policy", () => {
  it("requires verification for ranked and cash, not casual", async () => {
    const reg = new InMemoryPersonhoodRegistry();

    await expect(assertPersonhood(reg, A, "casual")).resolves.toBeUndefined();
    await expect(assertPersonhood(reg, A, "ranked")).rejects.toThrow(/personhood/);
    await expect(assertPersonhood(reg, A, "cash")).rejects.toThrow(/personhood/);

    await verifyAndRegister(verifier, reg, A, "human-1");
    await expect(assertPersonhood(reg, A, "ranked")).resolves.toBeUndefined();
    await expect(assertPersonhood(reg, A, "cash")).resolves.toBeUndefined();
  });
});
