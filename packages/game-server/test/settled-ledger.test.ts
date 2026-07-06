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

  it("tallies wins and net prize, biggest winners first", async () => {
    const ledger = new SettledLedger(new InMemoryLedgerStore());
    await ledger.recordWin(A, 100n);
    await ledger.recordWin(B, 300n);
    await ledger.recordWin(A, 100n);
    expect(await ledger.top(10)).toEqual([
      { address: B, wins: 1, netWei: "300" },
      { address: A, wins: 2, netWei: "200" },
    ]);
    expect(await ledger.top(1)).toHaveLength(1);
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
