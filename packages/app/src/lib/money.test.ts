import { describe, it, expect } from "vitest";
import { parseUnits } from "viem";
import { computePayout, stakeFloor, MIN_STAKE } from "./money.js";

describe("computePayout", () => {
  it("winner takes the pot minus the rake; a draw refund would take none", () => {
    const stake = parseUnits("1", 18);
    const { pot, rake, prize } = computePayout(stake, 800); // 8%
    expect(pot).toBe(parseUnits("2", 18));
    expect(rake).toBe(parseUnits("0.16", 18)); // 8% of 2
    expect(prize).toBe(pot - rake);
  });

  it("never mints money: prize + rake always equals the pot", () => {
    for (const bps of [0, 250, 800, 1000]) {
      const { pot, rake, prize } = computePayout(parseUnits("0.37", 18), bps);
      expect(rake + prize).toBe(pot);
    }
  });
});

describe("stakeFloor", () => {
  const dec = 18;
  const client = parseUnits(MIN_STAKE, dec);

  it("enforces the client minimum when the contract's minStake is 0 (kills dust)", () => {
    expect(stakeFloor(0n, dec)).toBe(client);
  });

  it("uses the on-chain minStake when it is higher than the client floor", () => {
    const higher = parseUnits("5", dec);
    expect(stakeFloor(higher, dec)).toBe(higher);
  });

  it("keeps the client floor when the on-chain minStake is lower", () => {
    const lower = parseUnits("0.01", dec);
    expect(stakeFloor(lower, dec)).toBe(client);
  });

  it("scales with token decimals (a 6-decimal stablecoin)", () => {
    expect(stakeFloor(0n, 6)).toBe(parseUnits(MIN_STAKE, 6));
  });
});
