// First-move commit–reveal.
//
// Who moves first is decided by a two-party commitment: player 0 commits
// keccak256(secret0) in createMatch, player 1 commits keccak256(secret1) in
// joinMatch, and the contract derives the flip from BOTH secrets once they are
// revealed. Neither side can steer it — player 0 commits before an opponent
// even exists, and player 1 chooses their secret without ever seeing secret0.
//
// This replaced a future-blockhash flip, which on Celo's ~1s blocks left only a
// ~4-minute window in which the result was publicly computable but not yet
// committed — long enough for whichever player disliked it to stall for a free
// re-roll. A commitment fixes the result before anyone can see it.
//
// The secret rides along on transactions the player already sends, so the
// scheme costs no extra gas — which matters in MiniPay, where every tx is paid
// for in the user's stablecoin.

import { keccak256, type Hex } from "viem";

/** A fresh 32-byte secret. MUST be new for every match: reusing one publishes
 *  it, and an opponent who knows your secret can grind theirs to pick the
 *  outcome. */
export function newFlipSecret(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/** The on-chain commitment for a secret. Must equal the contract's
 *  keccak256(abi.encode(secret)) — for a bytes32 that is just the hash of the
 *  32 bytes, the same shape as the invite-code commitment. */
export function commitmentOf(secret: Hex): Hex {
  return keccak256(secret);
}

// --- per-match persistence --- //
//
// localStorage, for the same reason session keys use it: the secret must
// survive the tab closing, or a player who backgrounds the app between joining
// and revealing could never start their match, and the stake would sit until
// the TTL refund.

const key = (matchId: bigint) => `awale.flip.${matchId.toString()}`;

export function persistFlipSecret(matchId: bigint, secret: Hex): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key(matchId), secret);
  } catch {
    /* quota — ignore */
  }
}

export function loadFlipSecret(matchId: bigint): Hex | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key(matchId)) as Hex | null;
  } catch {
    return null;
  }
}

/** The secret for `matchId`, generating and persisting one if this is the
 *  first call. Idempotent on purpose: a join can be retried after a dropped
 *  RPC, and a second secret would commit to a value the first attempt never
 *  stored — leaving the player unable to reveal. */
export function ensureFlipSecret(matchId: bigint): Hex {
  const existing = loadFlipSecret(matchId);
  if (existing) return existing;
  const secret = newFlipSecret();
  persistFlipSecret(matchId, secret);
  return secret;
}

/** A match created but not yet assigned an id (createMatch returns it only
 *  after the receipt) parks its secret here, then re-keys once the id lands. */
const PENDING = "awale.flip.pending";

export function stashPendingSecret(secret: Hex): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PENDING, secret);
  } catch {
    /* quota — ignore */
  }
}

/** Move the stashed secret onto its real match id. Returns the secret so the
 *  caller can reveal it without a second read. */
export function claimPendingSecret(matchId: bigint): Hex | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const secret = localStorage.getItem(PENDING) as Hex | null;
    if (secret) {
      persistFlipSecret(matchId, secret);
      localStorage.removeItem(PENDING);
    }
    return secret;
  } catch {
    return null;
  }
}

// --- revealing --- //

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

/**
 * Hand this match's secret to the server so it can fix the first mover.
 *
 * Safe to call eagerly and to retry: the server refuses any reveal until the
 * match is Active (both halves committed on chain), and a repeat of the same
 * secret is a no-op. Best-effort by design — if it never lands, either player
 * can still call finalizeStart themselves, and an unrevealed match simply
 * refunds both stakes at the TTL rather than starting unfairly.
 *
 * Returns true once the server has accepted the reveal.
 */
export async function revealFlipSecret(matchId: bigint): Promise<boolean> {
  const secret = loadFlipSecret(matchId);
  if (!secret || !SERVER_URL) return false;
  try {
    const res = await fetch(`${SERVER_URL}/match/reveal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ matchId: matchId.toString(), secret }),
    });
    return res.ok;
  } catch {
    return false; // offline / server down — the keeper path still exists
  }
}
