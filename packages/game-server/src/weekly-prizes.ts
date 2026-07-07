// On-chain Weekly-race payout via the WeeklyPrizes Merkle distributor.
//
// The custodial path (leagueClaim: the operator wallet sends each winner their
// prize from a private ledger) is replaced — when WEEKLY_PRIZES_ADDRESS is set —
// by funding each week's pot INTO the contract and publishing a Merkle root over
// the winners. A winner then claims from the CONTRACT with a proof, so the money
// is escrowed and the winners list is sealed on-chain: they can collect even if
// the server disappears. The tree is built by buildPrizeTree (src/league.ts),
// whose leaf matches the contract: keccak256(abi.encode(account, amount)).

import type { Address } from "viem";

export const weeklyPrizesAbi = [
  {
    type: "function",
    name: "publishRound",
    stateMutability: "nonpayable",
    inputs: [
      { name: "round", type: "uint256" },
      { name: "token", type: "address" },
      { name: "root", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "reclaimAfter", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "round", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "isClaimable",
    stateMutability: "view",
    inputs: [
      { name: "round", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "claimed",
    stateMutability: "view",
    inputs: [
      { name: "round", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** A week key ("2026-07-06", the Monday's date) → a unique, monotonic uint256
 *  round id (20260706). The contract only needs uniqueness; this is readable. */
export function roundFromWeek(week: string): bigint {
  const digits = week.replace(/-/g, "");
  if (!/^\d{8}$/.test(digits)) throw new Error(`weekly-prizes: bad week key "${week}"`);
  return BigInt(digits);
}

export interface PublishedClaim {
  account: Address;
  amountWei: string;
  proof: `0x${string}`[];
}
