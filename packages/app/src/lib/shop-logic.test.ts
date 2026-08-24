import { describe, it, expect } from "vitest";
import { parseUnits } from "viem";
import { cardState, isUnlocked, purchaseCost, priceTag, toCurrencyUnits, type CatalogEntry } from "./shop-logic.js";

const DEC = 18;
// catalogue prices arrive NORMALISED to 18 dec, whatever the currency is
const onSale = (price: string, left: number | null = null): CatalogEntry => ({
  onSale: true,
  priceE18: parseUnits(price as `${number}`, 18),
  left,
});

const base = { itemId: 10, owned: false, equipped: false, hasAccount: true, unlocked: true, entry: onSale("0.25"), fallbackPrice: 0.25 };

describe("cardState", () => {
  it("free defaults are always equeippable, even with no account", () => {
    expect(cardState({ ...base, itemId: 0, hasAccount: false })).toBe("equip");
    expect(cardState({ ...base, itemId: 0, equipped: true })).toBe("equipped");
  });

  it("owned skins offer Equip; equipped wins over everything", () => {
    expect(cardState({ ...base, owned: true })).toBe("equip");
    expect(cardState({ ...base, owned: true, equipped: true })).toBe("equipped");
  });

  it("no account → connect (a buy would have no signer)", () => {
    expect(cardState({ ...base, hasAccount: false })).toBe("connect");
  });

  it("sold out beats buy", () => {
    expect(cardState({ ...base, entry: onSale("0.25", 0) })).toBe("sold-out");
  });

  it("catalogue says not on sale → coming-soon (a buy would fail)", () => {
    expect(cardState({ ...base, entry: { onSale: false, priceE18: 0n, left: null } })).toBe("coming-soon");
  });

  it("no catalogue AND no fallback price → coming-soon, never an empty Buy button", () => {
    expect(cardState({ ...base, entry: undefined, fallbackPrice: undefined })).toBe("coming-soon");
  });

  it("no catalogue yet but a fallback price → buy still possible", () => {
    expect(cardState({ ...base, entry: undefined })).toBe("buy");
  });

  it("on sale, not owned, account present → buy", () => {
    expect(cardState(base)).toBe("buy");
  });

  it("limited stock still purchasable while some remain", () => {
    expect(cardState({ ...base, entry: onSale("0.25", 3) })).toBe("buy");
  });

  it("rank-gated + not unlocked → locked (aspiration, never a revert)", () => {
    expect(cardState({ ...base, unlocked: false })).toBe("locked");
  });

  it("owning a gated skin beats the lock — an awarded trophy is equippable", () => {
    expect(cardState({ ...base, unlocked: false, owned: true })).toBe("equip");
  });

  it("no account beats the lock in the message order (connect first)", () => {
    expect(cardState({ ...base, unlocked: false, hasAccount: false })).toBe("connect");
  });
});

describe("isUnlocked", () => {
  it("ungated skins are always unlocked, even for a not-connected visitor", () => {
    expect(isUnlocked(undefined, null)).toBe(true);
    expect(isUnlocked(-1, null)).toBe(true);
    expect(isUnlocked(0, null)).toBe(true);
  });

  it("gated + unknown rank → locked", () => {
    expect(isUnlocked(3, null)).toBe(false);
  });

  it("unlocks exactly when the player's rank meets the gate", () => {
    expect(isUnlocked(3, 2)).toBe(false); // below
    expect(isUnlocked(3, 3)).toBe(true); // at
    expect(isUnlocked(3, 4)).toBe(true); // above
  });
});

describe("purchaseCost", () => {
  it("the on-chain price always wins over the fallback", () => {
    expect(purchaseCost(onSale("0.4"), 0.25, DEC)).toBe(parseUnits("0.4", DEC));
  });

  it("falls back to the hardcoded price before the catalogue loads", () => {
    expect(purchaseCost(undefined, 0.25, DEC)).toBe(parseUnits("0.25", DEC));
  });

  it("no price anywhere → 0 (the card must not offer a buy)", () => {
    expect(purchaseCost(undefined, undefined, DEC)).toBe(0n);
  });
});

describe("priceTag", () => {
  it("renders money language, not token symbols", () => {
    expect(priceTag(onSale("0.25"), undefined, DEC)).toBe("$0.25");
    expect(priceTag(undefined, 0.5, DEC)).toBe("$0.5");
    expect(priceTag(undefined, undefined, DEC)).toBe("");
  });
});

describe("toCurrencyUnits", () => {
  it("is a no-op for an 18-dec currency", () => {
    expect(toCurrencyUnits(parseUnits("0.5", 18), 18)).toBe(parseUnits("0.5", 18));
  });

  it("scales a normalised price down to a 6-dec currency", () => {
    expect(toCurrencyUnits(parseUnits("0.5", 18), 6)).toBe(parseUnits("0.5", 6));
  });

  it("truncates rather than rounding up against the buyer", () => {
    // 1e-9 of a dollar cannot be expressed at 6 decimals
    expect(toCurrencyUnits(1_000_000_000n, 6)).toBe(0n);
  });
});

describe("purchaseCost across currency decimals", () => {
  // the regression: one stored price must mean the same MONEY in either
  // currency. Before normalisation this pair differed by 1e12.
  it("quotes the same real price in 18-dec and 6-dec currencies", () => {
    const entry = onSale("0.25");
    expect(purchaseCost(entry, undefined, 18)).toBe(parseUnits("0.25", 18));
    expect(purchaseCost(entry, undefined, 6)).toBe(parseUnits("0.25", 6));
  });

  it("renders the same tag regardless of the currency's decimals", () => {
    expect(priceTag(onSale("0.25"), undefined, 6)).toBe("$0.25");
    expect(priceTag(onSale("0.25"), undefined, 18)).toBe("$0.25");
  });
});
