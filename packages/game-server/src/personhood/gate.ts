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
  /** the account that got registered — taken from the proof, not the body. */
  address?: Address;
}

const ZERO_ADDR = ("0x" + "0".repeat(40)) as Address;

/**
 * Verify a Self proof and register the human, enforcing one-human-per-account:
 * if the proof's nullifier already belongs to a *different* address, it is
 * rejected as a sybil/multi-account attempt.
 *
 * The registered account is the one the *proof* discloses (`res.userIdentifier`),
 * never an `address` carried alongside it — otherwise a client could mark
 * someone else's address verified. `address` is only a fallback for the
 * in-memory/mock verifier (tests), which discloses no identity.
 */
export async function verifyAndRegister(
  verifier: PersonhoodVerifier,
  registry: PersonhoodRegistry,
  address: Address | undefined,
  proof: PersonhoodProof,
): Promise<RegisterOutcome> {
  const res = await verifier.verify(address ?? ZERO_ADDR, proof);
  if (!res.ok || !res.nullifier) return { verified: false, reason: "invalid proof" };

  const account = res.userIdentifier ?? address;
  if (!account) return { verified: false, reason: "no account bound to this proof" };

  const owner = await registry.nullifierOwner(res.nullifier);
  if (owner && owner.toLowerCase() !== account.toLowerCase()) {
    return { verified: false, reason: "personhood already used by another account" };
  }

  await registry.register(account, res.nullifier);
  return { verified: true, address: account };
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
