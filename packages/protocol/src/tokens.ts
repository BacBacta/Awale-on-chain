// Stablecoin configuration for Celo / MiniPay.
//
// Read balances with the *token* address; pay the network fee with the
// *feeCurrency* address (USDC/USDT need their adapter, not the token, or the
// transaction fails). The engine handles 18-dec (USDm) vs 6-dec (USDC/USDT).

import { formatUnits, type Address } from "viem";

export type Stablecoin = "USDm" | "USDC" | "USDT";

export interface TokenInfo {
  symbol: Stablecoin;
  decimals: number;
  /** address used for balances and transfers */
  token: Address;
  /** address passed as `feeCurrency` for the network fee (CIP-64) */
  feeCurrency: Address;
}

/** Celo mainnet (chainId 42220) — architecture appendix. */
export const CELO_MAINNET_TOKENS: Record<Stablecoin, TokenInfo> = {
  USDm: {
    symbol: "USDm",
    decimals: 18,
    token: "0x765DE816845861e75A25fCA122bb6898B8B1282a",
    feeCurrency: "0x765DE816845861e75A25fCA122bb6898B8B1282a",
  },
  USDC: {
    symbol: "USDC",
    decimals: 6,
    token: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    feeCurrency: "0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B",
  },
  USDT: {
    symbol: "USDT",
    decimals: 6,
    token: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
    feeCurrency: "0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72",
  },
};

export const FEE_CURRENCY_DIRECTORY: Address = "0x15F344b9E6c3Cb6F0376A36A64928b13F62C6276";

export interface Balance {
  token: TokenInfo;
  raw: bigint;
}

/**
 * Pick the stablecoin the user should play with: the one with the highest
 * balance, compared in human units (so 18-dec vs 6-dec is apples-to-apples).
 * Returns null if every balance is zero (caller should show the Deposit flow).
 */
export function pickPreferredStablecoin(balances: Balance[]): Balance | null {
  let best: Balance | null = null;
  let bestHuman = 0;
  for (const b of balances) {
    if (b.raw === 0n) continue;
    const human = Number(formatUnits(b.raw, b.token.decimals));
    if (human > bestHuman) {
      bestHuman = human;
      best = b;
    }
  }
  return best;
}

/** Format a raw amount for display, trimmed to `maxFractionDigits`. */
export function formatAmount(raw: bigint, decimals: number, maxFractionDigits = 2): string {
  const s = formatUnits(raw, decimals);
  const n = Number(s);
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits });
}
