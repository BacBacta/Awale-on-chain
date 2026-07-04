// Stake bands (P0-3). Exact-amount matching splits a tiny player base into
// token × amount buckets — two people willing to play for roughly a dollar
// never meet because one typed 0.9 and the other 1.0. Bands group nearby
// stakes so they CAN pair; the match then settles at the LOWER of the two
// requested stakes (nobody is ever forced to risk more than they asked for).
//
// This is purely an OFF-CHAIN pairing concern. MatchEscrow is untouched: the
// on-chain match is still created at one exact stake (the resolved lower one).
//
// Boundaries are in dollars (token units), applied via `decimals`. Defaults:
//   micro < $0.50 ≤ low < $2 ≤ mid < $10 ≤ high

export type StakeBand = "micro" | "low" | "mid" | "high";

/** Upper boundaries (exclusive) for micro/low/mid, in whole token units.
 *  A stake ≥ the last boundary is "high". */
export interface BandBoundaries {
  microMax: number; // < this ⇒ micro
  lowMax: number; // < this ⇒ low
  midMax: number; // < this ⇒ mid; ≥ this ⇒ high
}

export const DEFAULT_BANDS: BandBoundaries = { microMax: 0.5, lowMax: 2, midMax: 10 };

/** Scale a decimal token amount (e.g. 0.5) to wei at `decimals`, exactly,
 *  without floating-point drift: split into integer and fractional parts. */
function toWei(amount: number, decimals: number): bigint {
  const [intPart, fracPartRaw = ""] = amount.toString().split(".");
  const frac = (fracPartRaw + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

/** The band a stake falls into. `stakeWei` is the on-chain integer amount. */
export function bandFor(stakeWei: bigint, decimals: number, bounds: BandBoundaries = DEFAULT_BANDS): StakeBand {
  const micro = toWei(bounds.microMax, decimals);
  const low = toWei(bounds.lowMax, decimals);
  const mid = toWei(bounds.midMax, decimals);
  if (stakeWei < micro) return "micro";
  if (stakeWei < low) return "low";
  if (stakeWei < mid) return "mid";
  return "high";
}

/** The stake a pairing settles at: the LOWER of the two requested amounts, so
 *  a player who asked for 0.9 never ends up risking 1.0. */
export function resolveStake(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
