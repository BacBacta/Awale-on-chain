// Pot / rake / prize math mirrored from MatchEscrow._payout, so the UI can show
// players exactly what they win *before* they commit a stake.
//
//   pot   = stake * 2
//   rake  = pot * rakeBps / 10_000   (no rake on a draw)
//   prize = pot - rake

import { formatUnits, parseUnits } from "viem";

const BPS = 10_000n;

export interface Payout {
  pot: bigint;
  rake: bigint;
  prize: bigint;
}

export function computePayout(stake: bigint, rakeBps: number): Payout {
  const pot = stake * 2n;
  const rake = (pot * BigInt(Math.max(0, Math.floor(rakeBps)))) / BPS;
  return { pot, rake, prize: pot - rake };
}

/** Format a base-unit amount as a trimmed human string (e.g. "1.95"). */
export function fmt(raw: bigint, decimals: number, maxFractionDigits = 2): string {
  const s = formatUnits(raw, decimals);
  if (!s.includes(".")) return s;
  const [int, frac] = s.split(".");
  const trimmed = frac.slice(0, maxFractionDigits).replace(/0+$/, "");
  return trimmed ? `${int}.${trimmed}` : int;
}

/** rakeBps (e.g. 250) → percent label (e.g. "2.5%"). */
export function rakePct(rakeBps: number): string {
  return `${(rakeBps / 100).toFixed(rakeBps % 100 === 0 ? 0 : 1)}%`;
}

// Single source for the STATIC marketing copy's "winner takes X% · Y% fee"
// (the guide, the home hero). The live per-match fee is still read from the
// contract in MatchActions; this is just so the headline numbers aren't
// hardcoded in three places and can't silently disagree with the rake. Set
// NEXT_PUBLIC_RAKE_BPS to match the deployed MatchEscrow rake.
export const RAKE_BPS = Number(process.env.NEXT_PUBLIC_RAKE_BPS ?? "800");

// Client-side minimum stake, in whole tokens. The contract enforces its own
// `minStake` too; this is a fail-fast floor for the UI and a backstop when the
// on-chain minStake is 0. Below this, the rake truncates toward zero (integer
// math) while the match still costs gas + infra — a net-negative game. Set
// NEXT_PUBLIC_MIN_STAKE to override (matches the lowest quick-stake preset).
export const MIN_STAKE = process.env.NEXT_PUBLIC_MIN_STAKE ?? "0.25";

/** The stake floor the UI enforces, in base units: the higher of the on-chain
 *  `minStake` and the client `MIN_STAKE`. Enforcing the client floor kills
 *  dust matches even when the contract's minStake is 0. */
export function stakeFloor(minStakeOnChain: bigint, decimals: number): bigint {
  const client = parseUnits(MIN_STAKE as `${number}`, decimals);
  return minStakeOnChain > client ? minStakeOnChain : client;
}
/** e.g. "92%" — winner's share of the pot. */
export const WINNER_PCT = `${Math.round((10_000 - RAKE_BPS) / 100)}%`;
/** e.g. "8%" — the house fee. */
export const FEE_PCT = rakePct(RAKE_BPS);

// Share of every house fee that flows into the Weekly race pot and is paid
// back to players each Monday. MUST track the server's LEAGUE_POOL_SHARE_BPS —
// production runs 4500 (45%) on both, so the default matches; set
// NEXT_PUBLIC_LEAGUE_POOL_SHARE_BPS if the server share changes. This constant
// is the single source for "almost half the fee returns to players", so a
// guide, an expander and an onboarding screen can never quote different numbers.
export const RACE_SHARE_BPS = Number(process.env.NEXT_PUBLIC_LEAGUE_POOL_SHARE_BPS ?? "4500");
/** e.g. "45%" — the slice of each fee that returns to players via the race pot. */
export const RACE_SHARE_PCT = `${Math.round(RACE_SHARE_BPS / 100)}%`;
