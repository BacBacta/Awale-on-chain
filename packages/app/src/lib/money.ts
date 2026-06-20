// Pot / rake / prize math mirrored from MatchEscrow._payout, so the UI can show
// players exactly what they win *before* they commit a stake.
//
//   pot   = stake * 2
//   rake  = pot * rakeBps / 10_000   (no rake on a draw)
//   prize = pot - rake

import { formatUnits } from "viem";

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
