import { describe, it, expect } from "vitest";
import { matchEscrowAbi, matchEscrowCompatAbi } from "../src/abis.js";

type Tuple = { name: string; type: string };

function getMatchComponents(abi: readonly unknown[]): Tuple[] {
  const fn = (abi as { type: string; name: string; outputs?: { components?: Tuple[] }[] }[]).find(
    (e) => e.type === "function" && e.name === "getMatch",
  );
  return fn?.outputs?.[0]?.components ?? [];
}

describe("matchEscrowCompatAbi", () => {
  const full = getMatchComponents(matchEscrowAbi);
  const compat = getMatchComponents(matchEscrowCompatAbi);

  it("describes a getMatch tuple", () => {
    expect(compat.length).toBeGreaterThan(0);
    expect(full.length).toBeGreaterThan(compat.length);
  });

  // The whole point: a static struct is encoded as consecutive words, so a
  // SHORT tuple decodes correctly against a longer one. That only holds while
  // compat is an exact prefix — one reordered or inserted field and every
  // legacy read silently returns the wrong column.
  it("is a strict prefix of the full tuple, name and type for name and type", () => {
    expect(full.slice(0, compat.length)).toEqual(compat);
  });

  // Fields past activeDeadline are exactly where the struct diverged between
  // escrow versions (v6 had revealBlock there; commit–reveal has commit0/1),
  // so extending compat into that region reintroduces the decode failure it
  // exists to avoid.
  it("stops at activeDeadline, the last version-stable field", () => {
    expect(compat[compat.length - 1]?.name).toBe("activeDeadline");
    expect(compat.map((c) => c.name)).not.toContain("commit0");
    expect(compat.map((c) => c.name)).not.toContain("revealBlock");
    expect(compat.map((c) => c.name)).not.toContain("transcriptCommitment");
  });

  it("still carries every field the cross-version screens read", () => {
    const names = compat.map((c) => c.name);
    for (const needed of [
      "status",
      "stake",
      "rakeBps",
      "player0",
      "player1",
      "activeDeadline",
      "challengeDeadline",
      "proposedWinner",
    ]) {
      expect(names).toContain(needed);
    }
  });
});
