// No-loss league (HarvestVault) client surface for the mini-app.
//
// Players deposit a stablecoin for a season; the pool earns yield in a lending
// market; at season end the principal is always returned and the yield is split
// across the leaderboard. This module exposes a minimal ABI + helpers.

import type { Address } from "viem";

export const LEAGUE_SEASON = BigInt(process.env.NEXT_PUBLIC_LEAGUE_SEASON ?? "1");

export function harvestAddress(): Address | null {
  const a = process.env.NEXT_PUBLIC_HARVEST_ADDRESS;
  return a ? (a as Address) : null;
}

export const SEASON_STATUS = { None: 0, Open: 1, Finalized: 2 } as const;

export interface Season {
  token: Address;
  pool: Address;
  depositDeadline: bigint;
  seasonEnd: bigint;
  status: number;
  totalPrincipal: bigint;
  redeemed: bigint;
  yieldPot: bigint;
  prizeDistributed: bigint;
  prizeMerkleRoot: `0x${string}`;
}

export const harvestVaultAbi = [
  {
    type: "function",
    name: "getSeason",
    stateMutability: "view",
    inputs: [{ name: "seasonId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "pool", type: "address" },
          { name: "depositDeadline", type: "uint64" },
          { name: "seasonEnd", type: "uint64" },
          { name: "status", type: "uint8" },
          { name: "totalPrincipal", type: "uint256" },
          { name: "redeemed", type: "uint256" },
          { name: "yieldPot", type: "uint256" },
          { name: "prizeDistributed", type: "uint256" },
          { name: "prizeMerkleRoot", type: "bytes32" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "principalOf",
    stateMutability: "view",
    inputs: [
      { name: "seasonId", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    // what claimPrincipal would actually pay now: the full deposit normally, or
    // the pro-rata share after a market shortfall (M-02). Show THIS, not the
    // nominal deposit, so the amount can never mislead.
    type: "function",
    name: "claimablePrincipal",
    stateMutability: "view",
    inputs: [
      { name: "seasonId", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    // audit gate: false until governance unlocks the yield system post-audit.
    // Read defensively — a legacy vault predating the gate lacks this function.
    type: "function",
    name: "seasonsUnlocked",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "seasonId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimPrincipal",
    stateMutability: "nonpayable",
    inputs: [{ name: "seasonId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claimPrize",
    stateMutability: "nonpayable",
    inputs: [
      { name: "seasonId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "seasonId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

// Faucet mint on the mock league stablecoin (testnet only — MockERC20.mint).
export const faucetAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** A short human countdown like "2d 4h" or "3h 12m"; "ended" when past. */
export function countdown(toUnixSeconds: bigint, now = Date.now()): string {
  const secs = Number(toUnixSeconds) - Math.floor(now / 1000);
  if (secs <= 0) return "ended";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
