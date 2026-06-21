import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { buildPrizeTree, verifyProof, splitPrizes, leafHash } from "../src/league.js";

const A = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Address;

describe("league prize Merkle tree", () => {
  it("every claim's proof verifies against the root (sorted-pair, OZ-compatible)", () => {
    const claims = [
      { account: A(1), amount: 100n },
      { account: A(2), amount: 50n },
      { account: A(3), amount: 25n },
      { account: A(4), amount: 10n },
      { account: A(5), amount: 5n }, // odd count -> exercises carry-up
    ];
    const tree = buildPrizeTree(claims);
    expect(tree.claims).toHaveLength(5);
    for (const c of tree.claims) {
      expect(verifyProof(tree.root, c.account, c.amount, c.proof)).toBe(true);
    }
  });

  it("rejects a tampered amount", () => {
    const tree = buildPrizeTree([
      { account: A(1), amount: 100n },
      { account: A(2), amount: 50n },
    ]);
    const c = tree.claims[0];
    expect(verifyProof(tree.root, c.account, 999n, c.proof)).toBe(false);
  });

  it("drops zero-amount claims and handles a single leaf", () => {
    const tree = buildPrizeTree([
      { account: A(1), amount: 0n },
      { account: A(2), amount: 7n },
    ]);
    expect(tree.claims).toHaveLength(1);
    expect(tree.root).toBe(leafHash(A(2), 7n)); // single leaf is the root
    expect(verifyProof(tree.root, A(2), 7n, tree.claims[0].proof)).toBe(true);
  });
});

describe("league prize split", () => {
  it("splits the pot by wins and never exceeds it", () => {
    const claims = splitPrizes(
      [
        { account: A(1), wins: 3, principal: 100n },
        { account: A(2), wins: 1, principal: 100n },
        { account: A(3), wins: 0, principal: 100n },
      ],
      1000n,
    );
    const total = claims.reduce((a, c) => a + c.amount, 0n);
    expect(total).toBe(1000n); // remainder folded into the top player
    const byWinner = Object.fromEntries(claims.map((c) => [c.account.toLowerCase(), c.amount]));
    expect(byWinner[A(1).toLowerCase()]).toBeGreaterThan(byWinner[A(2).toLowerCase()]);
  });

  it("falls back to principal-weighted split when nobody has won", () => {
    const claims = splitPrizes(
      [
        { account: A(1), wins: 0, principal: 300n },
        { account: A(2), wins: 0, principal: 100n },
      ],
      400n,
    );
    const total = claims.reduce((a, c) => a + c.amount, 0n);
    expect(total).toBe(400n);
    const by = Object.fromEntries(claims.map((c) => [c.account.toLowerCase(), c.amount]));
    expect(by[A(1).toLowerCase()]).toBe(300n);
    expect(by[A(2).toLowerCase()]).toBe(100n);
  });

  it("returns nothing when there is no yield", () => {
    expect(splitPrizes([{ account: A(1), wins: 1, principal: 1n }], 0n)).toEqual([]);
  });
});
