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

describe("parseStake", () => {
  it("converts human amounts to base units", () => {
    expect(parseStake("2.5", 6)).toBe(2_500_000n);
    expect(parseStake("1", 18)).toBe(1_000000000000000000n);
  });
});

describe("escrow writes set feeCurrency (CIP-64)", () => {
  it("createMatch builds the right request", async () => {
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
      feeCurrency: ADAPTER,
    });
  });

  it("joinMatch builds the right request", async () => {
    const { wallet, calls } = recorder();
    await joinMatch(wallet, { account: ACCOUNT, escrow: ESCROW, matchId: 7n, session: SESSION, feeCurrency: ADAPTER });
    expect(calls[0]).toMatchObject({
      functionName: "joinMatch",
      args: [7n, SESSION],
      feeCurrency: ADAPTER,
    });
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
