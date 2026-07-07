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
 * The two external primitives the resolver needs, injected so the resolver
 * LOGIC is fully implemented and unit-testable without bundling @celo/identity
 * (heavy, and useless without a funded ODIS quota + backend signer). At mainnet,
 * wire these to the real SDK — nothing else in the resolver changes:
 *
 *   import { OdisUtils } from "@celo/identity";
 *   const deps: OdisDeps = {
 *     obfuscate: async (e164) =>
 *       (await OdisUtils.Identifier.getObfuscatedIdentifier(
 *          e164, OdisUtils.Identifier.IdentifierPrefix.PHONE_NUMBER,
 *          issuerAddress, authSigner, odisContext)).obfuscatedIdentifier,
 *     lookupAccounts: (id) =>
 *       federatedAttestations.read.lookupAttestations([id, [ODIS_CONFIG.miniPayIssuer]])
 *         .then((r) => r.accounts),
 *     lookupIdentifiers: (addr) =>
 *       federatedAttestations.read.lookupIdentifiers([addr, [ODIS_CONFIG.miniPayIssuer]])
 *         .then((r) => r.identifiers),
 *   };
 *
 * Quota: PnP needs a non-zero allowance — OdisPayments.payInCUSD after an ERC-20
 * increaseAllowance, funded from the backend signer only. Keys never leave the
 * server. See ODIS_CONFIG for the mainnet contract addresses.
 */
export interface OdisDeps {
  /** E.164 phone -> its ODIS obfuscated identifier (PnP pepper + hash). */
  obfuscate(e164: string): Promise<string>;
  /** FederatedAttestations.lookupAttestations(identifier, [issuer]) -> accounts. */
  lookupAccounts(identifier: string): Promise<Address[]>;
  /** FederatedAttestations.lookupIdentifiers(address, [issuer]) -> identifiers.
   *  ODIS is one-way (you cannot reverse an identifier to a phone), so these are
   *  opaque — callers use their PRESENCE as "this address has a verified phone",
   *  not as displayable numbers. */
  lookupIdentifiers(address: Address): Promise<string[]>;
}

/**
 * Production {NameResolver} over ODIS + FederatedAttestations for the MiniPay
 * issuer. Fully implemented; `deps` injects the @celo/identity plumbing (see
 * {OdisDeps}). A failed lookup resolves to null/[] — a name that can't be
 * resolved is never an error the caller must handle, just an absent name.
 */
export function createOdisResolver(deps: OdisDeps): NameResolver {
  return {
    async resolveByPhone(e164: string): Promise<Address | null> {
      try {
        const identifier = await deps.obfuscate(e164);
        const accounts = await deps.lookupAccounts(identifier);
        return accounts.length > 0 ? accounts[0] : null;
      } catch {
        return null; // ODIS/quota hiccup — absent name, not a hard failure
      }
    },
    async attestationsFor(address: Address): Promise<string[]> {
      try {
        // opaque ODIS identifiers (one-way): their presence = "verified phone"
        return await deps.lookupIdentifiers(address);
      } catch {
        return [];
      }
    },
  };
}
