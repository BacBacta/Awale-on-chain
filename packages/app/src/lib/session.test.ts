import { describe, it, expect } from "vitest";
import { recoverAddress, type Address } from "viem";
import { createSessionKey, signMove, signResult } from "./session.js";
import { moveDigest, resultDigest } from "../../../protocol/src/eip712.js";

const VERIFIER: Address = "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3";
const ESCROW: Address = "0xf13D09eD3cbdD1C930d4de74808de1f33B6b3D4f";
const chainId = 31337n;

describe("session keys", () => {
  it("derives an address from a fresh keypair", () => {
    const s = createSessionKey();
    expect(s.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(s.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("produces move signatures that recover to the session address", async () => {
    const s = createSessionKey();
    const sig = await signMove(s, 1n, 0n, 3, { chainId, verifier: VERIFIER });
    const recovered = await recoverAddress({
      hash: moveDigest(1n, 0n, 3, { chainId, verifier: VERIFIER }),
      signature: sig,
    });
    expect(recovered.toLowerCase()).toBe(s.address.toLowerCase());
  });

  it("produces result signatures that recover to the session address", async () => {
    const s = createSessionKey();
    const sig = await signResult(s, 42n, 0, { chainId, escrow: ESCROW });
    const recovered = await recoverAddress({
      hash: resultDigest(42n, 0, { chainId, escrow: ESCROW }),
      signature: sig,
    });
    expect(recovered.toLowerCase()).toBe(s.address.toLowerCase());
  });

  it("generates a distinct key per call", () => {
    expect(createSessionKey().privateKey).not.toBe(createSessionKey().privateKey);
  });
});
