import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { GameHub } from "../src/hub.js";
import { SettlementCoordinator } from "../src/settlement-coordinator.js";
import { resultDigest } from "../src/eip712.js";
import type { SettlementClient } from "../src/chain.js";

const ESCROW: Address = "0x00000000000000000000000000000000000e5c70";
const VERIFIER: Address = "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3";
const CHAIN_ID = 31337n;
const acct0 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000a11ce0");
const acct1 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000b0b000");
const stranger = privateKeyToAccount("0x000000000000000000000000000000000000000000000000000000000000dead");

function hubWithTerminalMatch(matchId: bigint, winner: number) {
  const hub = new GameHub();
  hub.open({ matchId, chainId: CHAIN_ID, verifier: VERIFIER, sessions: [acct0.address, acct1.address], startTurn: 0 });
  const m = hub.get(matchId)!;
  m.state.over = true;
  m.state.winner = winner;
  return hub;
}

function recorder() {
  const calls: { matchId: bigint; winner: number }[] = [];
  const settlement = {
    settleSigned: async (matchId: bigint, winner: number) => {
      calls.push({ matchId, winner });
      return "0xhash" as Hex;
    },
  } as unknown as SettlementClient;
  return { settlement, calls };
}

describe("SettlementCoordinator", () => {
  it("settles once both session keys have signed the result", async () => {
    const hub = hubWithTerminalMatch(5n, 0);
    const { settlement, calls } = recorder();
    const coord = new SettlementCoordinator({ escrow: ESCROW, chainId: CHAIN_ID, settlement });

    const digest = resultDigest(5n, 0, { chainId: CHAIN_ID, escrow: ESCROW });
    const sig0 = await acct0.sign({ hash: digest });
    const sig1 = await acct1.sign({ hash: digest });

    expect(await coord.submit(hub, 5n, sig0)).toBe("collected");
    expect(calls).toHaveLength(0);
    expect(await coord.submit(hub, 5n, sig1)).toBe("settled");
    expect(calls).toEqual([{ matchId: 5n, winner: 0 }]);
    expect(hub.get(5n)).toBeUndefined(); // closed after settling
  });

  it("ignores a signature from a non-session key", async () => {
    const hub = hubWithTerminalMatch(6n, 1);
    const { settlement } = recorder();
    const coord = new SettlementCoordinator({ escrow: ESCROW, chainId: CHAIN_ID, settlement });

    const digest = resultDigest(6n, 1, { chainId: CHAIN_ID, escrow: ESCROW });
    const badSig = await stranger.sign({ hash: digest });
    expect(await coord.submit(hub, 6n, badSig)).toBe("ignored");
  });

  it("ignores result sigs before the game is over", async () => {
    const hub = new GameHub();
    hub.open({ matchId: 7n, chainId: CHAIN_ID, verifier: VERIFIER, sessions: [acct0.address, acct1.address], startTurn: 0 });
    const coord = new SettlementCoordinator({ escrow: ESCROW, chainId: CHAIN_ID });
    const digest = resultDigest(7n, 0, { chainId: CHAIN_ID, escrow: ESCROW });
    expect(await coord.submit(hub, 7n, await acct0.sign({ hash: digest }))).toBe("ignored");
  });
});
