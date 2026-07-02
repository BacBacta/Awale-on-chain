import { describe, it, expect } from "vitest";
import { initialState, applyMove, legalMovesMask, DRAW, NO_CAPTURE_LIMIT, type GameState } from "../src/awale.js";

function board(pits: number[], store0 = 0, store1 = 0, turn = 0, noCaptureCount = 0): GameState {
  return { pits: pits.slice(), store0, store1, turn, over: false, winner: 0, noCaptureCount };
}

describe("AwaleRules (TS engine)", () => {
  it("opens with four seeds per house and six legal moves", () => {
    const s = initialState();
    expect(s.pits).toEqual(Array(12).fill(4));
    expect(legalMovesMask(s)).toBe(0x3f);
  });

  it("sows without capturing into a non-2/3 opponent house", () => {
    const r = applyMove(initialState(), 2); // 3,4,5,6 -> house 6 becomes 5
    expect(r.pits[2]).toBe(0);
    expect(r.pits[6]).toBe(5);
    expect(r.store0).toBe(0);
    expect(r.turn).toBe(1);
  });

  it("captures 2/3 in the opponent row and walks backwards", () => {
    // player 0 plays house 5 (2 seeds) -> 6,7 both become 2; capture 2+2
    const r = applyMove(board([4, 0, 0, 0, 0, 2, 1, 1, 4, 0, 0, 0]), 5);
    expect(r.store0).toBe(4);
    expect(r.pits[6]).toBe(0);
    expect(r.pits[7]).toBe(0);
  });

  it("applies the grand-slam rule (capturing all opponent seeds captures none)", () => {
    const r = applyMove(board([4, 0, 0, 0, 0, 2, 1, 1, 0, 0, 0, 0]), 5);
    expect(r.store0).toBe(0);
    expect(r.pits[6]).toBe(2);
    expect(r.pits[7]).toBe(2);
  });

  it("enforces the feeding obligation", () => {
    // opponent empty; house 0 stays in own row -> illegal
    expect(() => applyMove(board([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), 0)).toThrow("must feed opponent");
    // house 5 reaches house 6 -> legal
    const r = applyMove(board([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), 5);
    expect(r.pits[6]).toBe(1);
  });

  it("ends and assigns the winner once a store passes 24", () => {
    const r = applyMove(board([4, 0, 0, 0, 0, 1, 1, 4, 0, 0, 0, 0], 24, 0, 0), 5);
    expect(r.over).toBe(true);
    expect(r.winner).toBe(0);
    expect(r.store0).toBe(26);
  });

  it("rejects moves once the game is over", () => {
    const s = { ...initialState(), over: true };
    expect(() => applyMove(s, 0)).toThrow("game over");
  });

  it("recognises a draw", () => {
    const r = applyMove(board([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0], 24, 22, 0), 5);
    expect(r.over).toBe(true);
    expect(r.winner).toBe(DRAW);
    expect(r.store0).toBe(24);
    expect(r.store1).toBe(24);
  });

  it("resets the no-capture streak on any capture", () => {
    // house 5 (2 seeds) -> lands in 6,7 making both 2 -> capture
    const r = applyMove(board([4, 0, 0, 0, 0, 2, 1, 1, 4, 0, 0, 0], 0, 0, 0, 12), 5);
    expect(r.store0).toBe(4);
    expect(r.noCaptureCount).toBe(0);
  });

  it("counts a non-capturing move against the streak", () => {
    const r = applyMove(board([4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4], 0, 0, 0, 5), 2);
    expect(r.noCaptureCount).toBe(6);
  });

  it("splits the board and ends in a draw after an endless cyclic run with no captures", () => {
    // both rows non-empty, no capture possible from this single-seed shuffle;
    // still one ply short of the limit after this move should stay live...
    const almost = applyMove(board([0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0], 23, 23, 0, NO_CAPTURE_LIMIT - 2), 2);
    expect(almost.over).toBe(false);
    expect(almost.noCaptureCount).toBe(NO_CAPTURE_LIMIT - 1);
    // ...crossing the limit ends the game and splits whatever remains on the board
    const r = applyMove(board([0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0], 23, 23, 0, NO_CAPTURE_LIMIT - 1), 2);
    expect(r.over).toBe(true);
    expect(r.winner).toBe(DRAW);
    expect(r.store0).toBe(24);
    expect(r.store1).toBe(24);
    expect(r.pits).toEqual(Array(12).fill(0));
  });
});
