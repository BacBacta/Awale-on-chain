// Keeper: drives time-based on-chain actions the players may not trigger
// themselves — finalising a proposed result once its challenge window closes,
// and voiding an Active match that was never settled past its TTL.
//
// The decision logic is pure (keeperActions); a runner executes the chosen
// actions via the SettlementClient.

import type { Hex } from "viem";
import type { SettlementClient } from "./chain.js";

/** MatchEscrow.Status enum order (see contracts/src/MatchEscrow.sol). */
export const EscrowStatus = {
  None: 0,
  Open: 1,
  Active: 2,
  Proposed: 3,
  Resolved: 4,
  Cancelled: 5,
  Voided: 6,
} as const;

/** startTurn sentinel meaning the first-move flip is not yet fixed (contract: START_UNSET). */
export const START_UNSET = 255;

export interface KeeperMatch {
  matchId: bigint;
  status: number;
  challengeDeadline: number; // unix seconds
  activeDeadline: number; // unix seconds
  startTurn?: number; // 0/1 once fixed, START_UNSET while pending
  revealBlock?: number; // block whose hash fixes startTurn
}

export type KeeperAction = { matchId: bigint; action: "finalize" | "voidExpired" | "finalizeStart" };

/**
 * Decide which on-chain actions are due. Pure and deterministic.
 *  - Proposed and past its challenge window           -> finalize
 *  - Active, first move not yet fixed, reveal block mined -> finalizeStart
 *  - Active and past its TTL                           -> voidExpired
 *
 * `blockNumber` is the current chain height (for the finalizeStart check); when
 * omitted, finalizeStart is never emitted.
 */
export function keeperActions(matches: KeeperMatch[], now: number, blockNumber = 0): KeeperAction[] {
  const out: KeeperAction[] = [];
  for (const m of matches) {
    if (m.status === EscrowStatus.Proposed && now > m.challengeDeadline) {
      out.push({ matchId: m.matchId, action: "finalize" });
    } else if (m.status === EscrowStatus.Active) {
      if (m.startTurn === START_UNSET && m.revealBlock && blockNumber > m.revealBlock) {
        out.push({ matchId: m.matchId, action: "finalizeStart" });
      } else if (m.activeDeadline > 0 && now > m.activeDeadline) {
        out.push({ matchId: m.matchId, action: "voidExpired" });
      }
    }
  }
  return out;
}

/**
 * Which match ids a chain rescan should (re-)watch. Pure.
 *
 * The keeper's `tracked` set is in-memory: every deploy wiped it, and any
 * match that went Active before a restart became invisible to the keeper
 * FOREVER — never finalized, never voided. That is exactly how real stakes
 * ended up frozen in Active matches (#17…#46) until a manual ops script.
 * A periodic rescan walks every id below `next` and re-adds the unknowns;
 * the keeper tick then reads each and prunes terminals into `terminal`.
 */
export function idsToRescan(next: bigint, trackedIds: ReadonlySet<string>, terminal: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let id = 1n; id < next; id++) {
    const key = id.toString();
    if (!trackedIds.has(key) && !terminal.has(key)) out.push(key);
  }
  return out;
}

/** Execute keeper actions, returning the hashes of those that were submitted.
 *  Each action gets its own try: one revert (e.g. voidExpired on a match the
 *  operator isn't a player of — the contract gates it to players) must not
 *  abort the whole batch, or a single poisoned match starves every other
 *  stuck match behind it, tick after tick. */
export async function runKeeper(
  client: SettlementClient,
  actions: KeeperAction[],
  onError?: (a: KeeperAction, err: unknown) => void,
): Promise<Hex[]> {
  const hashes: Hex[] = [];
  for (const a of actions) {
    try {
      if (a.action === "finalize") hashes.push(await client.finalize(a.matchId));
      else if (a.action === "finalizeStart") hashes.push(await client.finalizeStart(a.matchId));
      else hashes.push(await client.voidExpired(a.matchId));
    } catch (err) {
      onError?.(a, err);
    }
  }
  return hashes;
}
