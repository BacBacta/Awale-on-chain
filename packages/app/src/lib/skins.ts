// Cosmetic skins (ERC-1155). Free defaults are always equippable; premium skins
// must be owned (bought via Cosmetics.buy) before they can be equipped. The
// equipped choice is per-device (localStorage) and themes the board.

import type { Address } from "viem";

export interface Skin {
  key: string;
  kind: "board" | "seed";
  name: string;
  asset: string;
  itemId: number; // 0 = free default (not an on-chain item)
  price?: number; // primary-sale price in whole tokens
  /** Rank tier NAME required to buy this skin (see profile TIERS). Undefined =
   *  available to everyone. A locked skin is shown greyed with "reach X to
   *  unlock" — aspiration is the point: you SEE the prize before you earn it. */
  tier?: string;
  /** Limited edition — the on-chain maxSupply is the truth, this just labels it
   *  before the catalogue loads (scarcity is the desire lever). */
  limited?: boolean;
  /** Awarded, not sold — minted to the weekly-league champion. Not on primary
   *  sale (price 0 on-chain); the shop shows it as a trophy, ownable only by
   *  winning. */
  champion?: boolean;
}

export const BOARD_SKINS: Skin[] = [
  { key: "classic", kind: "board", name: "Classic Honey", asset: "/assets/wood.webp", itemId: 0 },
  { key: "ebony", kind: "board", name: "Ebony", asset: "/assets/wood-ebony.webp", itemId: 1, price: 0.5 },
  { key: "pale", kind: "board", name: "Pale Ash", asset: "/assets/wood-pale.webp", itemId: 2, price: 0.5, tier: "Harvester" },
  // flagship trophy: NOT for sale — minted only to the weekly-league champion
  // (ownerMint). Status you can't buy, visible to every opponent on your board;
  // limited by construction (one per week). The purest desire lever.
  { key: "midnight", kind: "board", name: "Midnight", asset: "/assets/wood-dark.webp", itemId: 3, limited: true, champion: true },
];

export const SEED_SKINS: Skin[] = [
  { key: "amber", kind: "seed", name: "Amber", asset: "/assets/seed.webp", itemId: 0 },
  { key: "jade", kind: "seed", name: "Jade", asset: "/assets/seed-jade.webp", itemId: 10, price: 0.25 },
  { key: "pearl", kind: "seed", name: "Pearl", asset: "/assets/seed-pearl.webp", itemId: 11, price: 0.25, tier: "Sower" },
  { key: "onyx", kind: "seed", name: "Onyx", asset: "/assets/seed-onyx.webp", itemId: 12, price: 0.25, tier: "Captor" },
];

export const ALL_SKINS = [...BOARD_SKINS, ...SEED_SKINS];

export interface EquippedSkin {
  wood: string;
  seed: string;
}

const DEFAULT: EquippedSkin = { wood: BOARD_SKINS[0].asset, seed: SEED_SKINS[0].asset };

export function getEquipped(): EquippedSkin {
  if (typeof localStorage === "undefined") return DEFAULT;
  try {
    return {
      wood: localStorage.getItem("awale.skin.board") || DEFAULT.wood,
      seed: localStorage.getItem("awale.skin.seed") || DEFAULT.seed,
    };
  } catch {
    return DEFAULT;
  }
}

export function equip(skin: Skin): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(skin.kind === "board" ? "awale.skin.board" : "awale.skin.seed", skin.asset);
  } catch {
    /* ignore */
  }
}

export function cosmeticsAddress(): Address | null {
  const a = process.env.NEXT_PUBLIC_COSMETICS_ADDRESS;
  return a ? (a as Address) : null;
}

export const cosmeticsAbi = [
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "amount", type: "uint256" },
      // the buyer's price cap: the shop passes the very cost it quoted, so an
      // owner price change landing mid-purchase reverts instead of spending the
      // standing 20x allowance at the new price
      { name: "maxCost", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "currency",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    // decimals of the *current* purchase currency. Read it rather than assuming:
    // the currency is owner-switchable and the Celo stablecoins disagree
    // (USDm 18, USDC/USDT 6), so a hardcoded guess misprices the whole shop by
    // a factor of 1e12 the moment it is switched.
    type: "function",
    name: "currencyDecimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    // public `items` mapping getter — the on-chain source of truth for price,
    // supply cap and units minted. Lets the shop show the real price (no drift
    // from the hardcoded fallbacks above), "sold out", and scarcity ("N left").
    type: "function",
    name: "items",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "exists", type: "bool" },
      { name: "priceE18", type: "uint256" },
      { name: "maxSupply", type: "uint256" },
      { name: "minted", type: "uint256" },
    ],
  },
] as const;
