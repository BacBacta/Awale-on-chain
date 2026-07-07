import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { moveDigest, resultDigest, stateHash } from "../src/eip712.js";

interface SigVectors {
  chainId: number;
  verifier: Address;
  escrow: Address;
  moves: { matchId: number; ply: number; house: number; state: Hex; digest: Hex }[];
  results: { matchId: number; winner: number; digest: Hex }[];
}

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, "../../../contracts/test/fixtures/sig-vectors.json");
const v: SigVectors = JSON.parse(readFileSync(path, "utf8"));

describe("EIP-712 digest parity with the contracts", () => {
  const chainId = BigInt(v.chainId);
  const verifier = getAddress(v.verifier);
  const escrow = getAddress(v.escrow);

  it("moveDigest matches ReplayVerifier.moveDigest", () => {
    for (const m of v.moves) {
      const got = moveDigest(BigInt(m.matchId), BigInt(m.ply), m.house, m.state, { chainId, verifier });
      expect(got.toLowerCase()).toBe(m.digest.toLowerCase());
    }
  });

  it("stateHash matches ReplayVerifier.stateHash for the opening position", () => {
    // the vectors bind the opening position (pits all 4, empty stores, turn 0)
    const opening = { pits: Array(12).fill(4), store0: 0, store1: 0, turn: 0, noCaptureCount: 0 };
    const got = stateHash(opening);
    for (const m of v.moves) {
      expect(got.toLowerCase()).toBe(m.state.toLowerCase());
    }
  });

  it("resultDigest matches MatchEscrow.resultDigest", () => {
    for (const r of v.results) {
      const got = resultDigest(BigInt(r.matchId), r.winner, { chainId, escrow });
      expect(got.toLowerCase()).toBe(r.digest.toLowerCase());
    }
  });
});
