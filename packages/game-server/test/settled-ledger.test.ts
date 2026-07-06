import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { SettledLedger, InMemoryLedgerStore, type LedgerStore } from "../src/settled-ledger.js";

const A: Address = "0x000000000000000000000000000000000000000a";
const B: Address = "0x000000000000000000000000000000000000000b";

describe("SettledLedger", () => {
  it("claim() is exactly-once per match id — the pipeline's idempotence gate", async () => {
    const ledger = new SettledLedger(new InMemoryLedgerStore());
    expect(await ledger.claim("7")).toBe(true);
    expect(await ledger.claim("7")).toBe(false); // watcher + backfill overlap
    expect(await ledger.claim("8")).toBe(true);
  });

  it("claims survive a 'restart' (fresh ledger over the same store)", async () => {
    const store: LedgerStore = new InMemoryLedgerStore();
    await new SettledLedger(store).claim("7");
    expect(await new SettledLedger(store).claim("7")).toBe(false);
  });

  it("tallies TRUE net (prize minus stake, loser debited), biggest winners first", async () => {
    const ledger = new SettledLedger(new InMemoryLedgerStore());
    // stake 100 each, prize 180 (rake 20): winner nets +80, loser nets -100
    await ledger.recordSettle(A, B, 180n, 100n);
    await ledger.recordSettle(B, A, 540n, 300n); // B wins one back at stake 300
    await ledger.recordSettle(A, B, 180n, 100n);
    expect(await ledger.top(10)).toEqual([
      // B: -100 (lost to A) +240 (won) -100 (lost to A) = +40, 1 win
      { address: B, wins: 1, netWei: "40" },
      // A: +80 -300 +80 = -140, 2 wins — a negative NET with wins still shows
      { address: A, wins: 2, netWei: "-140" },
    ]);
    expect(await ledger.top(1)).toHaveLength(1);
  });

  it("a player with losses but no wins never appears — it is a winners' board", async () => {
    const ledger = new SettledLedger(new InMemoryLedgerStore());
    await ledger.recordSettle(A, B, 180n, 100n);
    const rows = await ledger.top(10);
    expect(rows).toEqual([{ address: A, wins: 1, netWei: "80" }]);
  });

  it("remembers the last processed block for the backfill cursor", async () => {
    const ledger = new SettledLedger(new InMemoryLedgerStore());
    expect(await ledger.lastBlock()).toBeNull();
    await ledger.setLastBlock(123456n);
    expect(await ledger.lastBlock()).toBe(123456n);
  });
});

describe("SettledLedger.release (H3 — reserve → commit-or-release)", () => {
  it("a released id can be claimed again — a dropped settlement is retried, not lost", async () => {
    const { InMemoryLedgerStore } = await import("../src/settled-ledger.js");
    const store = new InMemoryLedgerStore();
    const ledger = new SettledLedger(store);
    expect(await ledger.claim("42")).toBe(true); // reserve
    await ledger.release("42"); // downstream failed
    expect(await ledger.claim("42")).toBe(true); // backfill can re-process it
  });

  it("release persists to the store (survives a fresh ledger)", async () => {
    const { InMemoryLedgerStore } = await import("../src/settled-ledger.js");
    const store = new InMemoryLedgerStore();
    await new SettledLedger(store).claim("9");
    await new SettledLedger(store).release("9");
    expect(await new SettledLedger(store).claim("9")).toBe(true); // no longer counted
  });
});
