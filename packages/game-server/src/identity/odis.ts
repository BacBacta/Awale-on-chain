// ODIS / SocialConnect configuration (Celo mainnet) and the production
// NameResolver shape.
//
// The concrete resolver is built with @celo/identity on the backend: ODIS PnP
// (needs non-zero quota — increaseAllowance on the stable token, then
// OdisPayments.payInCUSD) yields the pepper to obfuscate a phone number into its
// ODIS identifier, then FederatedAttestations is queried for the MiniPay trusted
// issuer to map identifier <-> address. Keys and quota live server-side only.
//
// It is wired in integration (it needs an RPC + funded ODIS quota); the cached
// service and handler in names.ts are what the unit tests cover.

import type { Address } from "viem";
import type { NameResolver } from "./names.js";

export const ODIS_CONFIG = {
  federatedAttestations: "0x0aD5b1d0C25ecF6266Dd951403723B2687d6aff2" as Address,
  odisPayments: "0xAE6B29f31B96e61DdDc792f45fDa4e4F0356D0CB" as Address,
  /** MiniPay's trusted attestation issuer. */
  miniPayIssuer: "0x7888612486844Bb9BE598668081c59A9f7367FBc" as Address,
} as const;

/**
 * Placeholder factory for the production resolver. Provide a configured
 * @celo/identity ODIS client + a backend signer to implement {NameResolver}
 * against {ODIS_CONFIG.miniPayIssuer}.
 */
export function createOdisResolver(_deps: unknown): NameResolver {
  throw new Error("createOdisResolver: wire @celo/identity (ODIS PnP + FederatedAttestations) in integration");
}
