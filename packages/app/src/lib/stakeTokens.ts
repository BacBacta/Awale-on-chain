// Stake-token registry. The mini-app can offer several stablecoins (USDm / USDC
// / USDT on mainnet); each carries its own decimals and CIP-64 feeCurrency
// adapter. Configure via NEXT_PUBLIC_STAKE_TOKENS (JSON array) for multi-token,
// or the single NEXT_PUBLIC_STAKE_TOKEN/SYMBOL/DECIMALS/FEE_CURRENCY vars.

import type { Address } from "viem";

export interface StakeToken {
  symbol: string;
  address: Address;
  decimals: number;
  /** CIP-64 fee-currency adapter (USDC/USDT need their adapter; omit for USDm). */
  feeCurrency?: Address;
  /** testnet mock with a public mint() faucet. */
  faucet?: boolean;
}

function fromJson(raw: string): StakeToken[] {
  const arr = JSON.parse(raw) as Partial<StakeToken>[];
  return arr
    .filter((t) => t.address && t.symbol)
    .map((t) => ({
      symbol: String(t.symbol),
      address: t.address as Address,
      decimals: Number(t.decimals ?? 18),
      feeCurrency: (t.feeCurrency as Address) || undefined,
      faucet: Boolean(t.faucet),
    }));
}

export function stakeTokens(): StakeToken[] {
  const raw = process.env.NEXT_PUBLIC_STAKE_TOKENS;
  if (raw) {
    try {
      const list = fromJson(raw);
      if (list.length) return list;
    } catch {
      /* fall through to single-token config */
    }
  }
  const address = process.env.NEXT_PUBLIC_STAKE_TOKEN as Address | undefined;
  if (!address) return [];
  return [
    {
      symbol: process.env.NEXT_PUBLIC_STAKE_SYMBOL || "USDC",
      address,
      decimals: Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "18"),
      feeCurrency: (process.env.NEXT_PUBLIC_FEE_CURRENCY as Address) || undefined,
      faucet: process.env.NEXT_PUBLIC_STAKE_FAUCET === "1",
    },
  ];
}

/** Index of the token to default to, given balances (highest balance wins). */
export function preferredIndex(tokens: StakeToken[], balances: bigint[]): number {
  let best = 0;
  let bestHuman = -1;
  tokens.forEach((t, i) => {
    const human = Number(balances[i] ?? 0n) / 10 ** t.decimals;
    if (human > bestHuman) {
      bestHuman = human;
      best = i;
    }
  });
  return best;
}
