import { describe, it, expect } from "vitest";
import type { Address, Hex } from "viem";
import { parseStake, createMatch, joinMatch, approve, type WriteClient } from "./escrow.js";

const ACCOUNT: Address = "0x0000000000000000000000000000000000000001";
const ESCROW: Address = "0x00000000000000000000000000000000000e5c70";
const TOKEN: Address = "0x000000000000000000000000000000000000700a";
const ADAPTER: Address = "0x0000000000000000000000000000000000000fee";
const SESSION: Address = "0x0000000000000000000000000000000000000005";

function recorder() {
  const calls: Record<string, unknown>[] = [];
  const wallet: WriteClient = {
    async writeContract(req) {
      calls.push(req);
      return "0xhash" as Hex;
    },
  };
  return { wallet, calls };
}

describe("escrowConfig", () => {
  // a fresh object per call put effect deps in an infinite refetch loop
  // (shop/league): every render made a new config, which re-ran the effect,
  // which set state, which re-rendered…
  it("returns a STABLE reference across calls", async () => {
    const { escrowConfig } = await import("./escrow.js");
    expect(escrowConfig()).toBe(escrowConfig());
  });
});

describe("parseStake", () => {
  it("converts human amounts to base units", () => {
    expect(parseStake("2.5", 6)).toBe(2_500_000n);
    expect(parseStake("1", 18)).toBe(1_000000000000000000n);
  });
});

describe("escrow writes gate feeCurrency (CIP-64)", () => {
  // Outside MiniPay (this test env: no injected provider) effectiveFeeCurrency
  // STRIPS the adapter — browser wallets reject the unknown Celo tx type. The
  // old assertions expected a pass-through and went stale when the gate landed.
  it("createMatch builds the right request — no feeCurrency outside MiniPay", async () => {
    const { wallet, calls } = recorder();
    await createMatch(wallet, {
      account: ACCOUNT,
      escrow: ESCROW,
      token: TOKEN,
      stake: 5_000_000n,
      session: SESSION,
      feeCurrency: ADAPTER,
    });
    expect(calls[0]).toMatchObject({
      address: ESCROW,
      functionName: "createMatch",
      args: [TOKEN, 5_000_000n, SESSION],
      account: ACCOUNT,
      feeCurrency: undefined,
    });
  });

  it("joinMatch builds the right request", async () => {
    const { wallet, calls } = recorder();
    await joinMatch(wallet, { account: ACCOUNT, escrow: ESCROW, matchId: 7n, session: SESSION, feeCurrency: ADAPTER });
    expect(calls[0]).toMatchObject({
      functionName: "joinMatch",
      args: [7n, SESSION],
      feeCurrency: undefined,
    });
  });

  it("passes the adapter through inside MiniPay", async () => {
    (globalThis as { window?: unknown }).window = { ethereum: { isMiniPay: true, request: async () => [] } };
    try {
      const { wallet, calls } = recorder();
      await joinMatch(wallet, { account: ACCOUNT, escrow: ESCROW, matchId: 7n, session: SESSION, feeCurrency: ADAPTER });
      expect(calls[0]).toMatchObject({ feeCurrency: ADAPTER });
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("approve targets the token and the escrow spender", async () => {
    const { wallet, calls } = recorder();
    await approve(wallet, { account: ACCOUNT, token: TOKEN, spender: ESCROW, amount: 5_000_000n, feeCurrency: ADAPTER });
    expect(calls[0]).toMatchObject({
      address: TOKEN,
      functionName: "approve",
      args: [ESCROW, 5_000_000n],
    });
  });
});
