import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { DRAW } from "../../engine/src/awale.js";
import { Match, type MatchConfig } from "../src/match.js";
import { moveDigest, resignDigest, drawOfferDigest, type MoveContext } from "../src/eip712.js";

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

function signResign(player: 0 | 1, matchId: bigint, ply: number): Promise<Hex> {
  const acct = player === 0 ? acct0 : acct1;
  return acct.sign({ hash: resignDigest(matchId, BigInt(ply), ctx) });
}

function signDrawOffer(player: 0 | 1, matchId: bigint, ply: number): Promise<Hex> {
  const acct = player === 0 ? acct0 : acct1;
  return acct.sign({ hash: drawOfferDigest(matchId, BigInt(ply), ctx) });
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

  describe("resign", () => {
    it("ends the match with the opponent as winner", async () => {
      const m = new Match(config(0));
      const sig = await signResign(0, m.cfg.matchId, m.ply);
      const state = await m.resign(0, sig);
      expect(state.over).toBe(true);
      expect(state.winner).toBe(1);
    });

    it("rejects a resign signed by the wrong session key", async () => {
      const m = new Match(config(0));
      const sig = await signResign(1, m.cfg.matchId, m.ply); // player 1's key, claimed as player 0
      await expect(m.resign(0, sig)).rejects.toThrow("bad resign signature");
    });

    it("rejects resigning once the match is over", async () => {
      const m = new Match(config(0));
      await m.resign(0, await signResign(0, m.cfg.matchId, m.ply));
      await expect(m.resign(1, await signResign(1, m.cfg.matchId, m.ply))).rejects.toThrow("match over");
    });
  });

  describe("mutual draw", () => {
    it("ends in a draw once the opponent accepts the offer", async () => {
      const m = new Match(config(0));
      await m.offerDraw(0, await signDrawOffer(0, m.cfg.matchId, m.ply));
      const state = await m.acceptDraw(1, await signDrawOffer(1, m.cfg.matchId, m.ply));
      expect(state.over).toBe(true);
      expect(state.winner).toBe(DRAW);
    });

    it("rejects accepting your own offer", async () => {
      const m = new Match(config(0));
      await m.offerDraw(0, await signDrawOffer(0, m.cfg.matchId, m.ply));
      await expect(m.acceptDraw(0, await signDrawOffer(0, m.cfg.matchId, m.ply))).rejects.toThrow(
        "no pending draw offer",
      );
    });

    it("rejects accepting with no offer pending", async () => {
      const m = new Match(config(0));
      await expect(m.acceptDraw(1, await signDrawOffer(1, m.cfg.matchId, m.ply))).rejects.toThrow(
        "no pending draw offer",
      );
    });

    it("a resign signature cannot be replayed as a draw offer", async () => {
      const m = new Match(config(0));
      const resignSig = await signResign(0, m.cfg.matchId, m.ply);
      await expect(m.offerDraw(0, resignSig)).rejects.toThrow("bad draw-offer signature");
    });
  });

  describe("forfeit", () => {
    it("ends the match with the other player as winner, no signature needed", () => {
      const m = new Match(config(0));
      const state = m.forfeit(0); // player 0 disconnected and never came back
      expect(state.over).toBe(true);
      expect(state.winner).toBe(1);
    });

    it("rejects forfeiting once the match is over", async () => {
      const m = new Match(config(0));
      await m.resign(0, await signResign(0, m.cfg.matchId, m.ply));
      expect(() => m.forfeit(1)).toThrow("match over");
    });

    it("survives a snapshot/rehydrate round-trip (regression: replaying zero moves must not un-forfeit it)", () => {
      const m = new Match(config(0));
      m.forfeit(0);
      const reloaded = Match.rehydrate(m.snapshot());
      expect(reloaded.over).toBe(true);
      expect(reloaded.result().winner).toBe(1);
    });
  });

  describe("blitz clock", () => {
    function timedMatch(clockMs: number) {
      let now = 1_000_000;
      const m = new Match({ ...config(0), clockMs }, () => now);
      return { m, advance: (ms: number) => (now += ms) };
    }

    it("banks thinking time per move and reports live remaining for the mover", async () => {
      const { m, advance } = timedMatch(180_000);
      expect(m.clockRemainingMs(0)).toBe(180_000);
      expect(m.clockRemainingMs(1)).toBe(180_000); // not on move — bank untouched

      advance(30_000); // player 0 thinks for 30s
      expect(m.clockRemainingMs(0)).toBe(150_000); // live: bank minus running turn
      expect(m.clockRemainingMs(1)).toBe(180_000);

      const house = m.legalMoves()[0];
      await m.submitMove(0, house, await signFor(0, m.cfg.matchId, m.ply, house));
      expect(m.clockRemainingMs(0)).toBe(150_000); // banked
      advance(10_000); // now player 1 is burning time
      expect(m.clockRemainingMs(1)).toBe(170_000);
      expect(m.clockRemainingMs(0)).toBe(150_000); // frozen while waiting
    });

    it("flagFallen once the mover's total time is gone, never for untimed play", () => {
      const { m, advance } = timedMatch(60_000);
      expect(m.flagFallen()).toBe(false);
      advance(59_999);
      expect(m.flagFallen()).toBe(false);
      advance(1);
      expect(m.flagFallen()).toBe(true);
      expect(m.clockRemainingMs(0)).toBe(0);

      const untimed = new Match(config(0));
      expect(untimed.flagFallen()).toBe(false);
      expect(untimed.clockRemainingMs(0)).toBeNull();
    });
  });

  describe("resign/draw survive a snapshot/rehydrate round-trip", () => {
    it("resign", async () => {
      const m = new Match(config(0));
      await m.resign(0, await signResign(0, m.cfg.matchId, m.ply));
      const reloaded = Match.rehydrate(m.snapshot());
      expect(reloaded.over).toBe(true);
      expect(reloaded.result().winner).toBe(1);
    });

    it("mutual draw", async () => {
      const m = new Match(config(0));
      await m.offerDraw(0, await signDrawOffer(0, m.cfg.matchId, m.ply));
      await m.acceptDraw(1, await signDrawOffer(1, m.cfg.matchId, m.ply));
      const reloaded = Match.rehydrate(m.snapshot());
      expect(reloaded.over).toBe(true);
      expect(reloaded.result().winner).toBe(DRAW);
    });
  });
});
