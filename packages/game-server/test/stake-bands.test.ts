import { describe, it, expect } from "vitest";
import { bandFor, resolveStake, DEFAULT_BANDS } from "../src/stake-bands.js";

// 18-decimal token (aUSD). `$(n)` = n dollars in wei.
const D = 18;
const $ = (n: number): bigint => {
  const [i, f = ""] = n.toString().split(".");
  return BigInt(i) * 10n ** BigInt(D) + BigInt((f + "0".repeat(D)).slice(0, D) || "0");
};

describe("stake bands (P0-3)", () => {
  describe("bandFor — default boundaries micro<$0.50≤low<$2≤mid<$10≤high", () => {
    it("classifies representative amounts", () => {
      expect(bandFor($(0.1), D)).toBe("micro");
      expect(bandFor($(0.49), D)).toBe("micro");
      expect(bandFor($(0.5), D)).toBe("low"); // boundary is inclusive of the upper band
      expect(bandFor($(1), D)).toBe("low");
      expect(bandFor($(1.99), D)).toBe("low");
      expect(bandFor($(2), D)).toBe("mid");
      expect(bandFor($(9.99), D)).toBe("mid");
      expect(bandFor($(10), D)).toBe("high");
      expect(bandFor($(100), D)).toBe("high");
    });

    it("puts 0.9 and 1.0 in the SAME band (the fragmentation this fixes)", () => {
      expect(bandFor($(0.9), D)).toBe(bandFor($(1.0), D));
      expect(bandFor($(0.9), D)).toBe("low");
    });

    it("is exact at the wei boundary — no floating-point drift", () => {
      const half = $(0.5);
      expect(bandFor(half - 1n, D)).toBe("micro");
      expect(bandFor(half, D)).toBe("low");
    });

    it("honours a 6-decimal token (e.g. USDC)", () => {
      const d6 = 6;
      const usdc = (n: number) => BigInt(Math.round(n * 1e6));
      expect(bandFor(usdc(0.49), d6)).toBe("micro");
      expect(bandFor(usdc(0.5), d6)).toBe("low");
      expect(bandFor(usdc(5), d6)).toBe("mid");
      expect(bandFor(usdc(10), d6)).toBe("high");
    });

    it("accepts custom boundaries", () => {
      const bounds = { microMax: 1, lowMax: 5, midMax: 50 };
      expect(bandFor($(0.9), D, bounds)).toBe("micro");
      expect(bandFor($(3), D, bounds)).toBe("low");
    });

    it("exposes sane defaults", () => {
      expect(DEFAULT_BANDS).toEqual({ microMax: 0.5, lowMax: 2, midMax: 10 });
    });
  });

  describe("resolveStake — settle at the lower of the two", () => {
    it("returns the smaller amount", () => {
      expect(resolveStake($(0.9), $(1.0))).toBe($(0.9));
      expect(resolveStake($(1.0), $(0.9))).toBe($(0.9));
      expect(resolveStake($(1), $(1))).toBe($(1));
    });
  });
});
