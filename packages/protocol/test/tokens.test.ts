import { describe, it, expect } from "vitest";
import {
  CELO_MAINNET_TOKENS,
  pickPreferredStablecoin,
  formatAmount,
  type Balance,
} from "../src/tokens.js";

const { USDm, USDC, USDT } = CELO_MAINNET_TOKENS;

describe("token config", () => {
  it("uses the adapter address as feeCurrency for 6-dec tokens", () => {
    expect(USDC.decimals).toBe(6);
    expect(USDC.feeCurrency).not.toBe(USDC.token); // adapter, not the token
    expect(USDm.decimals).toBe(18);
    expect(USDm.feeCurrency).toBe(USDm.token); // USDm is its own feeCurrency
  });
});

describe("pickPreferredStablecoin", () => {
  it("compares balances in human units across decimals", () => {
    // 5 USDC (6 dec) vs 3 USDm (18 dec) -> USDC wins on human value
    const balances: Balance[] = [
      { token: USDC, raw: 5_000_000n },
      { token: USDm, raw: 3_000000000000000000n },
    ];
    expect(pickPreferredStablecoin(balances)?.token.symbol).toBe("USDC");
  });

  it("ignores zero balances and returns null when all are zero", () => {
    const balances: Balance[] = [
      { token: USDC, raw: 0n },
      { token: USDT, raw: 0n },
    ];
    expect(pickPreferredStablecoin(balances)).toBeNull();
  });

  it("prefers the larger human balance", () => {
    const balances: Balance[] = [
      { token: USDC, raw: 1_000_000n }, // 1 USDC
      { token: USDT, raw: 9_000_000n }, // 9 USDT
    ];
    expect(pickPreferredStablecoin(balances)?.token.symbol).toBe("USDT");
  });
});

describe("formatAmount", () => {
  it("formats 6-dec and 18-dec amounts", () => {
    expect(formatAmount(1_500_000n, 6)).toBe("1.5");
    expect(formatAmount(2_500000000000000000n, 18)).toBe("2.5");
  });
});
