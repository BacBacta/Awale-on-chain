// Pure decision logic for the Style shop cards — extracted so the card state
// machine is unit-testable and the page component stays purely presentational.
// Money language only: prices render as "$0.25", never a token symbol.

import { parseUnits } from "viem";
import { fmt } from "./money.js";

/** On-chain catalogue entry for one item (from the Cosmetics `items` mapping). */
export interface CatalogEntry {
  onSale: boolean; // exists && price > 0
  price: bigint; // base units
  left: number | null; // remaining supply; null = unlimited
}

export type CardState = "equipped" | "equip" | "connect" | "sold-out" | "coming-soon" | "buy";

/** Which single action a shop card offers, in priority order. */
export function cardState(p: {
  itemId: number;
  owned: boolean;
  equipped: boolean;
  hasAccount: boolean;
  entry: CatalogEntry | undefined;
  fallbackPrice: number | undefined;
}): CardState {
  const own = p.itemId === 0 || p.owned; // free defaults are always owned
  if (p.equipped) return "equipped";
  if (own) return "equip";
  if (!p.hasAccount) return "connect";
  if (p.entry?.left === 0) return "sold-out";
  // catalogue says not purchasable, or we know nothing about the price at all
  if (p.entry ? !p.entry.onSale : p.fallbackPrice == null) return "coming-soon";
  return "buy";
}

/** What a purchase would cost, in base units. On-chain price wins; the
 *  hardcoded fallback only bridges the gap before the catalogue loads. */
export function purchaseCost(entry: CatalogEntry | undefined, fallbackPrice: number | undefined, decimals: number): bigint {
  if (entry && entry.price > 0n) return entry.price;
  if (fallbackPrice != null && fallbackPrice > 0) return parseUnits(String(fallbackPrice) as `${number}`, decimals);
  return 0n;
}

/** "$0.25" — the only price format the shop shows. */
export function priceTag(entry: CatalogEntry | undefined, fallbackPrice: number | undefined, decimals: number): string {
  const cost = purchaseCost(entry, fallbackPrice, decimals);
  return cost > 0n ? `$${fmt(cost, decimals)}` : "";
}
