// Real proof-of-personhood verifier backed by Self (https://self.xyz).
//
// The mini-app builds a SelfApp (scope + this server's /self/verify endpoint)
// and the user's Self mobile app submits the resulting ZK proof straight to
// that endpoint. SelfBackendVerifier checks the proof's validity, age/OFAC
// policy, and scope binding; on success it discloses a per-human `nullifier`
// that verifyAndRegister() uses to enforce one-human-per-account.

import {
  SelfBackendVerifier,
  DefaultConfigStore,
  AllIds,
  type AttestationId,
  type VerificationConfig,
} from "@selfxyz/core";
import type { Address } from "viem";
import type { PersonhoodVerifier, VerifyResult } from "./types.js";

/** SelfBackendVerifier.verify()'s second parameter type, which the SDK doesn't export. */
type VcAndDiscloseProof = Parameters<SelfBackendVerifier["verify"]>[1];

/** The exact payload the Self mobile app POSTs to our verification endpoint. */
export interface SelfProof {
  attestationId: number;
  proof: unknown;
  publicSignals: string[];
  userContextData: string;
}

export interface SelfVerifierOptions {
  /** Unique scope identifying this app to Self (e.g. "awale-on-chain"). */
  scope: string;
  /** This server's public verification endpoint, e.g. https://.../self/verify. */
  endpoint: string;
  /** true on Celo Sepolia / Self staging, false against real passports on mainnet. */
  mockPassport: boolean;
  config?: VerificationConfig;
}

function isSelfProof(proof: unknown): proof is SelfProof {
  if (typeof proof !== "object" || proof === null) return false;
  const p = proof as Record<string, unknown>;
  return (
    typeof p.attestationId === "number" &&
    Array.isArray(p.publicSignals) &&
    typeof p.userContextData === "string"
  );
}

export class SelfPersonhoodVerifier implements PersonhoodVerifier {
  private readonly verifier: SelfBackendVerifier;

  constructor(opts: SelfVerifierOptions) {
    const configStore = new DefaultConfigStore(
      opts.config ?? { minimumAge: 18, ofac: true, excludedCountries: [] },
    );
    this.verifier = new SelfBackendVerifier(
      opts.scope,
      opts.endpoint,
      opts.mockPassport,
      AllIds,
      configStore,
      "hex", // the player's address (0x...) is the user identifier
    );
  }

  async verify(_address: Address, proof: unknown): Promise<VerifyResult> {
    if (!isSelfProof(proof)) return { ok: false };

    const result = await this.verifier.verify(
      proof.attestationId as AttestationId,
      proof.proof as VcAndDiscloseProof,
      proof.publicSignals,
      proof.userContextData,
    );

    if (!result.isValidDetails.isValid) return { ok: false };
    if (result.isValidDetails.isOfacValid) return { ok: false };
    if (!result.isValidDetails.isMinimumAgeValid) return { ok: false };

    return { ok: true, nullifier: result.discloseOutput.nullifier };
  }
}
