// Pure decision logic for the Style shop cards — extracted so the card state
// machine is unit-testable and the page component stays purely presentational.
// Money language only: prices render as "$0.25", never a token symbol.

import { parseUnits } from "viem";
import { fmt } from "./money.js";

/** On-chain catalogue entry for one item (from the Cosmetics `items` mapping). */
export interface CatalogEntry {
  onSale: boolean; // exists && priceE18 > 0
  priceE18: bigint; // NORMALISED 18-dec price — scale with `toCurrencyUnits`
  left: number | null; // remaining supply; null = unlimited
}

/** Scale a normalised 18-dec price into `decimals` base units. Mirrors
 *  `Cosmetics._toCurrency` exactly — same truncation — so the price the shop
 *  quotes is to the wei what `buy` will actually pull. */
export function toCurrencyUnits(priceE18: bigint, decimals: number): bigint {
  if (decimals >= 18) return priceE18;
  return priceE18 / 10n ** BigInt(18 - decimals);
}

export type CardState = "equipped" | "equip" | "connect" | "locked" | "sold-out" | "coming-soon" | "buy";

/** Which single action a shop card offers, in priority order. `unlocked` is
 *  false when the skin is rank-gated and the player hasn't reached the tier —
 *  it renders greyed with "reach X to unlock", never a Buy they'd revert on. */
export function cardState(p: {
  itemId: number;
  owned: boolean;
  equipped: boolean;
  hasAccount: boolean;
  unlocked: boolean;
  entry: CatalogEntry | undefined;
  fallbackPrice: number | undefined;
}): CardState {
  const own = p.itemId === 0 || p.owned; // free defaults are always owned
  if (p.equipped) return "equipped";
  if (own) return "equip"; // owning it (bought or awarded) always beats the gate
  if (!p.hasAccount) return "connect";
  if (!p.unlocked) return "locked"; // rank gate not met — aspiration, not a sale
  if (p.entry?.left === 0) return "sold-out";
  // catalogue says not purchasable, or we know nothing about the price at all
  if (p.entry ? !p.entry.onSale : p.fallbackPrice == null) return "coming-soon";
  return "buy";
}

/** Does the player's rank meet a skin's tier gate? `tierRank` is the index of
 *  the skin's required tier in the TIERS ladder (0 = none/lowest); `playerRank`
 *  is the player's own tier index. Ungated skins (tierRank undefined) are
 *  always unlocked, including for a not-yet-connected visitor. */
export function isUnlocked(tierRank: number | undefined, playerRank: number | null): boolean {
  if (tierRank === undefined || tierRank <= 0) return true;
  if (playerRank === null) return false; // gated + unknown rank → locked
  return playerRank >= tierRank;
}

/** What a purchase would cost, in base units. On-chain price wins; the
 *  hardcoded fallback only bridges the gap before the catalogue loads. */
export function purchaseCost(entry: CatalogEntry | undefined, fallbackPrice: number | undefined, decimals: number): bigint {
  if (entry && entry.priceE18 > 0n) return toCurrencyUnits(entry.priceE18, decimals);
  if (fallbackPrice != null && fallbackPrice > 0) return parseUnits(String(fallbackPrice) as `${number}`, decimals);
  return 0n;
}

/** "$0.25" — the only price format the shop shows. */
export function priceTag(entry: CatalogEntry | undefined, fallbackPrice: number | undefined, decimals: number): string {
  const cost = purchaseCost(entry, fallbackPrice, decimals);
  return cost > 0n ? `$${fmt(cost, decimals)}` : "";
}
