// Proof-of-personhood gating (Self) for anti-sybil on ranked/cash play.
//
// Self produces a ZK proof carrying a per-human *nullifier*: the same person
// yields the same nullifier, which lets us enforce one-human-per-account without
// learning any personal data. The verifier (Self SDK) is injected; the registry
// stores who is verified and which nullifier they used.

import type { Address } from "viem";

/** Opaque proof the client obtains from Self and submits to the backend. */
export type PersonhoodProof = unknown;

export interface VerifyResult {
  ok: boolean;
  /** stable per-human identifier, present when ok */
  nullifier?: string;
}

export interface PersonhoodVerifier {
  verify(address: Address, proof: PersonhoodProof): Promise<VerifyResult>;
}

export interface PersonhoodRegistry {
  isVerified(address: Address): Promise<boolean>;
  /** the address that first registered `nullifier`, or null */
  nullifierOwner(nullifier: string): Promise<Address | null>;
  register(address: Address, nullifier: string): Promise<void>;
}

export type PlayMode = "casual" | "ranked" | "cash";

export interface GatePolicy {
  /** modes that require a verified human */
  require: Set<PlayMode>;
}

export const DEFAULT_POLICY: GatePolicy = { require: new Set<PlayMode>(["ranked", "cash"]) };
