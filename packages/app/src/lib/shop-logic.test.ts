import { describe, it, expect } from "vitest";
import { parseUnits } from "viem";
import { cardState, purchaseCost, priceTag, type CatalogEntry } from "./shop-logic.js";

const DEC = 18;
const onSale = (price: string, left: number | null = null): CatalogEntry => ({
  onSale: true,
  price: parseUnits(price as `${number}`, DEC),
  left,
});

const base = { itemId: 10, owned: false, equipped: false, hasAccount: true, entry: onSale("0.25"), fallbackPrice: 0.25 };

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
    expect(cardState({ ...base, entry: { onSale: false, price: 0n, left: null } })).toBe("coming-soon");
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
