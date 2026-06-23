// ODIS / SocialConnect: map a phone number → wallet address (privacy-preserving),
// so a player can challenge a contact by number. The pepper derivation needs
// @celo/identity + funded ODIS quota (mainnet-only), so it's INJECTED — keeping
// that heavy, server-only dependency optional. The on-chain FederatedAttestations
// lookup is real (viem). Without ODIS configured the resolver returns null and the
// caller falls back to a shareable invite link.

import { createPublicClient, http, type Address } from "viem";
import { celo } from "viem/chains";
import type { NameResolver } from "./names.js";

export const ODIS_CONFIG = {
  federatedAttestations: "0x0aD5b1d0C25ecF6266Dd951403723B2687d6aff2" as Address,
  odisPayments: "0xAE6B29f31B96e61DdDc792f45fDa4e4F0356D0CB" as Address,
  /** MiniPay's trusted attestation issuer. */
  miniPayIssuer: "0x7888612486844Bb9BE598668081c59A9f7367FBc" as Address,
} as const;

// FederatedAttestations: identifier ⇄ address attestations registered by issuers.
const federatedAttestationsAbi = [
  {
    type: "function",
    name: "lookupAttestations",
    stateMutability: "view",
    inputs: [
      { name: "identifier", type: "bytes32" },
      { name: "trustedIssuers", type: "address[]" },
    ],
    outputs: [
      { name: "countsPerIssuer", type: "uint256[]" },
      { name: "accounts", type: "address[]" },
      { name: "signers", type: "address[]" },
      { name: "issuedOns", type: "uint256[]" },
      { name: "publishedOns", type: "uint256[]" },
    ],
  },
] as const;

/**
 * E.164 phone → ODIS identifier (bytes32). The only step needing @celo/identity +
 * funded ODIS quota. To wire on mainnet: `npm i @celo/identity`, fund quota
 * (OdisPayments.payInCUSD), and implement with
 * `OdisUtils.Identifier.getObfuscatedIdentifier(...)` + a backend AuthSigner.
 * Return null when quota/keys are unavailable.
 */
export type Obfuscate = (e164: string) => Promise<`0x${string}` | null>;

export interface OdisResolverDeps {
  /** Mainnet RPC (FederatedAttestations lives on Celo mainnet). */
  rpcUrl?: string;
  /** Phone → ODIS identifier. Omit to disable resolution (always returns null). */
  obfuscate?: Obfuscate;
  /** Trusted issuer(s) to look up under; defaults to MiniPay's. */
  trustedIssuers?: Address[];
}

/**
 * Production NameResolver: derive the ODIS identifier for a phone (injected,
 * quota-gated), then read FederatedAttestations on mainnet for the trusted issuer
 * to map it to a wallet address. Returns null when ODIS isn't configured, the
 * number isn't registered with the issuer, or anything errors — so the caller can
 * gracefully fall back to a shareable invite link.
 */
export function createOdisResolver(deps: OdisResolverDeps = {}): NameResolver {
  const client = createPublicClient({ chain: celo, transport: http(deps.rpcUrl) });
  const issuers = deps.trustedIssuers ?? [ODIS_CONFIG.miniPayIssuer];

  return {
    async resolveByPhone(e164: string): Promise<Address | null> {
      if (!deps.obfuscate) return null; // ODIS not configured → caller falls back
      try {
        const identifier = await deps.obfuscate(e164);
        if (!identifier) return null;
        const res = (await client.readContract({
          address: ODIS_CONFIG.federatedAttestations,
          abi: federatedAttestationsAbi,
          functionName: "lookupAttestations",
          args: [identifier, issuers],
        })) as readonly [readonly bigint[], readonly Address[], ...unknown[]];
        const accounts = res[1];
        return accounts.length > 0 ? accounts[0] : null;
      } catch {
        return null;
      }
    },
    async attestationsFor(): Promise<string[]> {
      return []; // reverse lookup (address → phone) is privacy-sensitive; not exposed
    },
  };
}
