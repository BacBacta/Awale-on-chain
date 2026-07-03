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

    // all three must hold: the proof is valid, the human is 18+, and they pass
    // the OFAC screen. (The OFAC line was inverted — it rejected clean users
    // and, in mock mode where the check always passes, blocked everyone.)
    if (!result.isValidDetails.isValid) return { ok: false };
    if (!result.isValidDetails.isMinimumAgeValid) return { ok: false };
    if (!result.isValidDetails.isOfacValid) return { ok: false };

    // the account is disclosed by the proof itself (userIdType "hex"), so
    // registration keys on a cryptographically-bound identity rather than any
    // address the request body might also carry
    return {
      ok: true,
      nullifier: result.discloseOutput.nullifier,
      userIdentifier: normalizeHexId(result.userData.userIdentifier),
    };
  }
}

/** Self returns the hex userId as either a 0x string or a decimal bigint —
 *  normalize both to a lowercase 0x address. */
function normalizeHexId(id: string): Address | undefined {
  try {
    if (id.startsWith("0x")) return `0x${id.slice(2).toLowerCase().padStart(40, "0")}` as Address;
    return `0x${BigInt(id).toString(16).padStart(40, "0")}` as Address;
  } catch {
    return undefined;
  }
}
