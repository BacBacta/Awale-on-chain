import { describe, it, expect } from "vitest";
import { isMiniPay } from "./minipay.js";
import { addCashDeeplink, receiptDeeplink } from "./deeplinks.js";
import { shortAddress, maskPhone, displayName } from "./identity.js";

describe("MiniPay detection", () => {
  it("is true only when the provider flags isMiniPay", () => {
    expect(isMiniPay({ isMiniPay: true })).toBe(true);
    expect(isMiniPay({ isMiniPay: false })).toBe(false);
    expect(isMiniPay(null)).toBe(false);
    expect(isMiniPay(undefined)).toBe(false);
  });
});

describe("deeplinks", () => {
  it("builds the Add Cash deeplink with default tokens", () => {
    expect(addCashDeeplink()).toBe("https://link.minipay.xyz/add_cash?tokens=USDm,USDC,USDT");
  });

  it("builds a receipt deeplink with celebration", () => {
    expect(receiptDeeplink("0xabc")).toBe("https://link.minipay.xyz/receipt?tx=0xabc&celebrate");
    expect(receiptDeeplink("0xabc", false)).toBe("https://link.minipay.xyz/receipt?tx=0xabc");
  });
});

describe("identity (phone-first)", () => {
  it("shortens an address", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });

  it("masks a phone number", () => {
    expect(maskPhone("+233201234567")).toBe("+23••••67");
  });

  it("prefers name, then phone, then a short address", () => {
    const address = "0x1234567890abcdef1234567890abcdef12345678";
    expect(displayName({ name: "Ama", phone: "+233201234567", address })).toBe("Ama");
    expect(displayName({ phone: "+233201234567", address })).toBe("+23••••67");
    expect(displayName({ address })).toBe("0x1234…5678");
  });
});
