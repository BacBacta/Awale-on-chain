import type { Address } from "viem";
import {
  type PersonhoodVerifier,
  type PersonhoodRegistry,
  type PersonhoodProof,
  type PlayMode,
  type GatePolicy,
  DEFAULT_POLICY,
} from "./types.js";

export interface RegisterOutcome {
  verified: boolean;
  reason?: string;
}

/**
 * Verify a Self proof and register the human, enforcing one-human-per-account:
 * if the proof's nullifier already belongs to a *different* address, it is
 * rejected as a sybil/multi-account attempt.
 */
export async function verifyAndRegister(
  verifier: PersonhoodVerifier,
  registry: PersonhoodRegistry,
  address: Address,
  proof: PersonhoodProof,
): Promise<RegisterOutcome> {
  const res = await verifier.verify(address, proof);
  if (!res.ok || !res.nullifier) return { verified: false, reason: "invalid proof" };

  const owner = await registry.nullifierOwner(res.nullifier);
  if (owner && owner.toLowerCase() !== address.toLowerCase()) {
    return { verified: false, reason: "personhood already used by another account" };
  }

  await registry.register(address, res.nullifier);
  return { verified: true };
}

/** Throw if `address` may not play `mode` under `policy`. */
export async function assertPersonhood(
  registry: PersonhoodRegistry,
  address: Address,
  mode: PlayMode,
  policy: GatePolicy = DEFAULT_POLICY,
): Promise<void> {
  if (!policy.require.has(mode)) return;
  if (!(await registry.isVerified(address))) {
    throw new Error(`personhood verification required for ${mode} play`);
  }
}
