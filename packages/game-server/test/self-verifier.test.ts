import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { SelfPersonhoodVerifier } from "../src/personhood/self-verifier.js";

const A: Address = "0x000000000000000000000000000000000000000a";

describe("SelfPersonhoodVerifier", () => {
  const verifier = new SelfPersonhoodVerifier({
    scope: "awale-test",
    endpoint: "https://example.test/self/verify",
    mockPassport: true,
  });

  it("rejects malformed proofs without calling the SDK", async () => {
    await expect(verifier.verify(A, null)).resolves.toEqual({ ok: false });
    await expect(verifier.verify(A, {})).resolves.toEqual({ ok: false });
    await expect(verifier.verify(A, { attestationId: 1 })).resolves.toEqual({ ok: false });
  });
});
