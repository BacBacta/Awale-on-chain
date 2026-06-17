import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { keccak256, toBytes, hexToBytes, type Hex } from "viem";
import { initialState, applyMove, type GameState } from "../src/awale.js";

interface Vector {
  startTurn: number;
  moves: number[];
  finalPits: number[];
  store0: number;
  store1: number;
  turn: number;
  over: boolean;
  winner: number;
  plyHash: Hex;
}

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = join(here, "../../../contracts/test/fixtures/vectors.json");
const vectors: Vector[] = JSON.parse(readFileSync(vectorsPath, "utf8"));

// Rolling hash, mixed over every intermediate state. Byte layout is identical
// to GenVectors.s.sol::_mix — 32-byte acc, 12 pit bytes, then the five scalars.
const SEED = keccak256(toBytes("AWALE_VECTORS_V1"));

function mix(acc: Hex, s: GameState): Hex {
  const buf = new Uint8Array(49);
  buf.set(hexToBytes(acc), 0);
  for (let i = 0; i < 12; i++) buf[32 + i] = s.pits[i];
  buf[44] = s.store0;
  buf[45] = s.store1;
  buf[46] = s.turn;
  buf[47] = s.over ? 1 : 0;
  buf[48] = s.winner;
  return keccak256(buf);
}

describe("TS ⇆ Solidity parity", () => {
  it("loads a varied set of vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(40);
    // sanity: the generator produced terminated games with every outcome
    expect(vectors.some((v) => v.over && v.winner === 0)).toBe(true);
    expect(vectors.some((v) => v.over && v.winner === 1)).toBe(true);
    expect(vectors.some((v) => v.over && v.winner === 2)).toBe(true);
  });

  vectors.forEach((v, gi) => {
    it(`game ${gi} (startTurn ${v.startTurn}, ${v.moves.length} plies) replays byte-identically`, () => {
      let s = initialState();
      s.turn = v.startTurn;
      let acc = mix(SEED, s);

      for (const house of v.moves) {
        s = applyMove(s, house);
        acc = mix(acc, s);
      }

      // final-state parity
      expect(s.pits).toEqual(v.finalPits);
      expect(s.store0).toBe(v.store0);
      expect(s.store1).toBe(v.store1);
      expect(s.turn).toBe(v.turn);
      expect(s.over).toBe(v.over);
      expect(s.winner).toBe(v.winner);

      // every-ply parity, in a single number
      expect(acc).toBe(v.plyHash);

      // seed conservation must hold throughout
      const total = s.pits.reduce((a, b) => a + b, 0) + s.store0 + s.store1;
      expect(total).toBe(48);
    });
  });
});
