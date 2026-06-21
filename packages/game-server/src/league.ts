// No-loss league finalization helpers (pure).
//
// At season end the yield is split across the standings and committed to the
// HarvestVault as a Merkle root. The leaf and tree must match the contract:
//   leaf      = keccak256(abi.encode(address account, uint256 amount))
//   internals = keccak256(sortedPair(a, b))   (OpenZeppelin MerkleProof)
// so a proof built here verifies in HarvestVault.claimPrize.

import { keccak256, encodeAbiParameters, concat, type Address, type Hex } from "viem";

export interface Claim {
  account: Address;
  amount: bigint;
}

export interface PrizeTree {
  root: Hex;
  claims: { account: Address; amount: bigint; proof: Hex[] }[];
}

export function leafHash(account: Address, amount: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, amount]));
}

function hashPair(a: Hex, b: Hex): Hex {
  return keccak256(concat(a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a]));
}

/** Build a sorted-pair Merkle tree (OZ-compatible) and every leaf's proof. */
export function buildPrizeTree(claims: Claim[]): PrizeTree {
  const filtered = claims.filter((c) => c.amount > 0n);
  if (filtered.length === 0) return { root: ("0x" + "00".repeat(32)) as Hex, claims: [] };

  const leaves = filtered.map((c) => leafHash(c.account, c.amount));
  // layers[0] = leaves; build up to the root
  const layers: Hex[][] = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]); // odd node carries up
    }
    layers.push(next);
  }
  const root = layers[layers.length - 1][0];

  const out = filtered.map((c, idx) => {
    const proof: Hex[] = [];
    let i = idx;
    for (let l = 0; l < layers.length - 1; l++) {
      const layer = layers[l];
      const sib = i % 2 === 0 ? i + 1 : i - 1;
      if (sib < layer.length) proof.push(layer[sib]);
      i = Math.floor(i / 2);
    }
    return { account: c.account, amount: c.amount, proof };
  });

  return { root, claims: out };
}

/** Local mirror of OpenZeppelin MerkleProof.verify (sorted pairs). */
export function verifyProof(root: Hex, account: Address, amount: bigint, proof: Hex[]): boolean {
  let h = leafHash(account, amount);
  for (const p of proof) h = hashPair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}

/**
 * Split `yieldPot` across standings. Players are ranked by `wins`; the pot is
 * distributed proportionally to wins (winner-takes-more), with any rounding
 * remainder going to the top player. If nobody has a win, it is split
 * proportionally to principal so deposits still earn their share.
 */
export function splitPrizes(
  standings: { account: Address; wins: number; principal: bigint }[],
  yieldPot: bigint,
): Claim[] {
  if (yieldPot <= 0n || standings.length === 0) return [];

  const totalWins = standings.reduce((a, s) => a + s.wins, 0);
  const weights: { account: Address; w: bigint }[] =
    totalWins > 0
      ? standings.map((s) => ({ account: s.account, w: BigInt(s.wins) }))
      : standings.map((s) => ({ account: s.account, w: s.principal }));

  const totalW = weights.reduce((a, x) => a + x.w, 0n);
  if (totalW === 0n) return [];

  const ranked = [...standings].sort((a, b) => b.wins - a.wins || (b.principal > a.principal ? 1 : -1));
  const amounts = new Map<string, bigint>();
  let distributed = 0n;
  for (const { account, w } of weights) {
    const amt = (yieldPot * w) / totalW;
    amounts.set(account.toLowerCase(), amt);
    distributed += amt;
  }
  // give the rounding remainder to the top player
  const remainder = yieldPot - distributed;
  if (remainder > 0n && ranked.length > 0) {
    const top = ranked[0].account.toLowerCase();
    amounts.set(top, (amounts.get(top) ?? 0n) + remainder);
  }
  return [...amounts.entries()].map(([account, amount]) => ({ account: account as Address, amount }));
}
