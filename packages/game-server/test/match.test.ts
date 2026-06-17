import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { Match, type MatchConfig } from "../src/match.js";
import { moveDigest, type MoveContext } from "../src/eip712.js";

const VERIFIER: Address = "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3";
const CHAIN_ID = 31337n;

const acct0 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000a11ce0");
const acct1 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000b0b000");

function config(startTurn: 0 | 1 = 0): MatchConfig {
  return {
    matchId: 1n,
    chainId: CHAIN_ID,
    verifier: VERIFIER,
    sessions: [acct0.address, acct1.address],
    startTurn,
  };
}

const ctx: MoveContext = { chainId: CHAIN_ID, verifier: VERIFIER };

function signFor(player: 0 | 1, matchId: bigint, ply: number, house: number): Promise<Hex> {
  const acct = player === 0 ? acct0 : acct1;
  return acct.sign({ hash: moveDigest(matchId, BigInt(ply), house, ctx) });
}

describe("Match orchestration", () => {
  it("accepts correctly-signed moves and advances state", async () => {
    const m = new Match(config(0));
    const house = m.legalMoves()[0];
    const sig = await signFor(0, m.cfg.matchId, m.ply, house);
    await m.submitMove(0, house, sig);

    expect(m.ply).toBe(1);
    expect(m.turn).toBe(1);
    expect(m.transcript().moves).toEqual([house]);
    expect(m.transcript().sigs.length).toBe(1);
  });

  it("rejects a move out of turn", async () => {
    const m = new Match(config(0));
    const house = m.legalMoves()[0];
    const sig = await signFor(1, m.cfg.matchId, m.ply, house);
    await expect(m.submitMove(1, house, sig)).rejects.toThrow("not your turn");
  });

  it("rejects a move signed by the wrong session key", async () => {
    const m = new Match(config(0));
    const house = m.legalMoves()[0];
    // player 0's move signed by player 1's key
    const sig = await signFor(1, m.cfg.matchId, m.ply, house);
    await expect(m.submitMove(0, house, sig)).rejects.toThrow("bad move signature");
  });

  it("rejects an illegal move even when correctly signed", async () => {
    const m = new Match(config(0));
    // find an empty / illegal house for player 0 at the opening: all are legal,
    // so instead sign an out-of-range house, which the engine rejects
    const badHouse = 9;
    const sig = await signFor(0, m.cfg.matchId, m.ply, badHouse);
    await expect(m.submitMove(0, badHouse, sig)).rejects.toThrow();
  });

  it("plays a full game and agrees with the engine outcome", async () => {
    const m = new Match(config(0));
    let guard = 0;
    while (!m.over && guard++ < 5000) {
      const player = m.turn as 0 | 1;
      const house = m.legalMoves()[0];
      const sig = await signFor(player, m.cfg.matchId, m.ply, house);
      await m.submitMove(player, house, sig);
    }
    expect(m.over).toBe(true);
    const { winner } = m.result();
    expect([0, 1, 2]).toContain(winner);

    // transcript is complete and aligned
    const t = m.transcript();
    expect(t.moves.length).toBe(t.sigs.length);
    expect(t.startTurn).toBe(0);
  });

  it("rejects any move once the game is over", async () => {
    const m = new Match(config(0));
    let guard = 0;
    while (!m.over && guard++ < 5000) {
      const player = m.turn as 0 | 1;
      const house = m.legalMoves()[0];
      await m.submitMove(player, house, await signFor(player, m.cfg.matchId, m.ply, house));
    }
    const sig = await signFor(0, m.cfg.matchId, m.ply, 0);
    await expect(m.submitMove(0, 0, sig)).rejects.toThrow("match over");
  });
});
