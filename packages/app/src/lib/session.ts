// Per-match session keys.
//
// MiniPay forbids wallet message signing, so each match uses an ephemeral
// keypair generated locally (never the wallet key). The player authorises it
// on-chain via joinMatch(matchId, sessionAddress); thereafter every move is
// signed in-app with this key over the exact on-chain move digest. The key is
// scoped to a single match, so its worst-case compromise is bounded by one
// stake. We deliberately reuse the shared @awale/protocol digests so signatures
// verify on-chain.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  moveDigest,
  resultDigest,
  resignDigest,
  drawOfferDigest,
  stateHash,
  type MoveContext,
  type ResultContext,
  type MovePosition,
} from "../../../protocol/src/eip712.js";

export interface SessionKey {
  privateKey: Hex;
  address: Address;
}

export function createSessionKey(): SessionKey {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

export function signMove(
  session: SessionKey,
  matchId: bigint,
  ply: bigint,
  house: number,
  position: MovePosition, // the PRE-move game state (its hash binds the signature)
  ctx: MoveContext,
): Promise<Hex> {
  return privateKeyToAccount(session.privateKey).sign({
    hash: moveDigest(matchId, ply, house, stateHash(position), ctx),
  });
}

export function signResult(
  session: SessionKey,
  matchId: bigint,
  winner: number,
  ctx: ResultContext,
): Promise<Hex> {
  return privateKeyToAccount(session.privateKey).sign({ hash: resultDigest(matchId, winner, ctx) });
}

export function signResign(session: SessionKey, matchId: bigint, ply: bigint, ctx: MoveContext): Promise<Hex> {
  return privateKeyToAccount(session.privateKey).sign({ hash: resignDigest(matchId, ply, ctx) });
}

export function signDrawOffer(session: SessionKey, matchId: bigint, ply: bigint, ctx: MoveContext): Promise<Hex> {
  return privateKeyToAccount(session.privateKey).sign({ hash: drawOfferDigest(matchId, ply, ctx) });
}

// --- per-match persistence --- //
//
// localStorage (not sessionStorage): a session key must survive the tab closing
// so a player can resume an in-flight match — otherwise a cash match could
// strand because the key to sign the result was lost. The key is still scoped to
// a single match, so its worst-case compromise is bounded by that one stake.

const key = (matchId: bigint) => `awale.session.${matchId.toString()}`;

export function persistSession(matchId: bigint, session: SessionKey): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key(matchId), JSON.stringify(session));
  } catch {
    /* quota — ignore */
  }
}

export function loadSession(matchId: bigint): SessionKey | null {
  if (typeof localStorage === "undefined") return null;
  try {
    // migrate any key written by the old sessionStorage build
    const raw = localStorage.getItem(key(matchId)) ?? sessionStorage?.getItem(key(matchId));
    return raw ? (JSON.parse(raw) as SessionKey) : null;
  } catch {
    return null;
  }
}
