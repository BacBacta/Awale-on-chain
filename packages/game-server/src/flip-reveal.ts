// First-move commit–reveal: collect one secret from each player, then fix the
// flip on-chain once both are in.
//
// Who moves first is keccak(secret0, secret1, matchId), where each player
// committed to their half in the transaction that staked them (create / join).
// Neither side can steer it: player 0 commits before an opponent exists, and
// player 1 commits without ever seeing secret0. This server holds no power over
// the result either — it only relays the pair to MatchEscrow.finalizeStart,
// which recomputes the flip itself and rejects a wrong preimage.
//
// Two rules make that safe:
//
//  1. A secret AUTHENTICATES ITSELF. It is accepted only if it hashes to one of
//     the commitments the match already carries on-chain, so a reveal needs no
//     signature, session or account — a valid preimage is the proof, and a
//     wrong one is simply refused.
//
//  2. Reveals are REFUSED UNTIL THE MATCH IS ACTIVE. Before that, player 1 has
//     not committed yet; letting secret0 reach this server early would give a
//     colluding joiner the one input they need to grind their own secret and
//     choose who starts. Waiting for Active means both halves are locked on
//     chain before either is spoken aloud.
//
// A player who never reveals cannot force a better start — the match simply
// never opens and voidExpired refunds BOTH players after the TTL.

import { keccak256, type Hex } from "viem";

/** MatchEscrow.Status.Active (see contracts/src/MatchEscrow.sol). */
export const STATUS_ACTIVE = 2;

/** The on-chain facts a reveal is checked against. */
export interface FlipCommitments {
  status: number;
  commit0: Hex;
  commit1: Hex;
}

export interface RevealState {
  secret0?: Hex;
  secret1?: Hex;
}

export type RevealResult =
  | { ok: false; reason: "not-active" | "unknown-secret" }
  | { ok: true; slot: 0 | 1; state: RevealState; ready: false }
  | { ok: true; slot: 0 | 1; state: RevealState; ready: true; secret0: Hex; secret1: Hex };

/** Mirrors the contract's `commitmentOf`: keccak256(abi.encode(secret)), which
 *  for a lone bytes32 is just the hash of those 32 bytes. */
export function commitmentOf(secret: Hex): Hex {
  return keccak256(secret);
}

/**
 * Fold one revealed secret into a match's reveal state. Pure — the caller owns
 * storage and the on-chain submission.
 */
export function applyReveal(m: FlipCommitments, prior: RevealState, secret: Hex): RevealResult {
  if (m.status !== STATUS_ACTIVE) return { ok: false, reason: "not-active" };

  const commitment = commitmentOf(secret);
  let slot: 0 | 1;
  if (commitment === m.commit0) slot = 0;
  else if (commitment === m.commit1) slot = 1;
  else return { ok: false, reason: "unknown-secret" };

  // re-revealing the same half is a no-op, not an error: a flaky network makes
  // the app retry, and a retry must not look like a failure to the player
  const state: RevealState = slot === 0 ? { ...prior, secret0: secret } : { ...prior, secret1: secret };

  return state.secret0 && state.secret1
    ? { ok: true, slot, state, ready: true, secret0: state.secret0, secret1: state.secret1 }
    : { ok: true, slot, state, ready: false };
}

/** In-memory reveal store, keyed by match id. Deliberately not durable: a
 *  secret lost to a restart is re-sent by the app (it keeps its own copy), and
 *  either player can always call finalizeStart themselves. */
export class RevealStore {
  private readonly byMatch = new Map<string, RevealState>();

  get(matchId: bigint): RevealState {
    return this.byMatch.get(matchId.toString()) ?? {};
  }

  /** Apply a reveal and persist the merged state. Returns the same verdict as
   *  {@link applyReveal}; nothing is stored on a rejection. */
  submit(matchId: bigint, m: FlipCommitments, secret: Hex): RevealResult {
    const result = applyReveal(m, this.get(matchId), secret);
    if (result.ok) this.byMatch.set(matchId.toString(), result.state);
    return result;
  }

  /** Both halves, once known — what finalizeStart needs. */
  pair(matchId: bigint): { secret0: Hex; secret1: Hex } | null {
    const s = this.get(matchId);
    return s.secret0 && s.secret1 ? { secret0: s.secret0, secret1: s.secret1 } : null;
  }

  /** Drop a settled match's secrets; they are spent once the flip is fixed. */
  forget(matchId: bigint): void {
    this.byMatch.delete(matchId.toString());
  }
}
