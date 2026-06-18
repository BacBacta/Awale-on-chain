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
  type MoveContext,
  type ResultContext,
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
  ctx: MoveContext,
): Promise<Hex> {
  return privateKeyToAccount(session.privateKey).sign({ hash: moveDigest(matchId, ply, house, ctx) });
}

export function signResult(
  session: SessionKey,
  matchId: bigint,
  winner: number,
  ctx: ResultContext,
): Promise<Hex> {
  return privateKeyToAccount(session.privateKey).sign({ hash: resultDigest(matchId, winner, ctx) });
}

// --- per-match persistence (sessionStorage; cleared when the tab closes) --- //

const key = (matchId: bigint) => `awale.session.${matchId.toString()}`;

export function persistSession(matchId: bigint, session: SessionKey): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(key(matchId), JSON.stringify(session));
}

export function loadSession(matchId: bigint): SessionKey | null {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(key(matchId));
  return raw ? (JSON.parse(raw) as SessionKey) : null;
}
