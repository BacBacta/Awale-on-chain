// JSON (de)serialization for match snapshots — bigints (matchId, chainId) are
// stored as decimal strings so the payload is plain JSON.

import type { MatchSnapshot } from "../match.js";

export function snapshotToJson(s: MatchSnapshot): string {
  return JSON.stringify({
    matchId: s.matchId.toString(),
    chainId: s.chainId.toString(),
    verifier: s.verifier,
    session0: s.session0,
    session1: s.session1,
    startTurn: s.startTurn,
    moves: s.moves,
    sigs: s.sigs,
  });
}

export function snapshotFromJson(json: string): MatchSnapshot {
  const o = JSON.parse(json);
  return {
    matchId: BigInt(o.matchId),
    chainId: BigInt(o.chainId),
    verifier: o.verifier,
    session0: o.session0,
    session1: o.session1,
    startTurn: o.startTurn,
    moves: o.moves,
    sigs: o.sigs,
  };
}
