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

export interface KeeperMatch {
  matchId: bigint;
  status: number;
  challengeDeadline: number; // unix seconds
  activeDeadline: number; // unix seconds
}

export type KeeperAction = { matchId: bigint; action: "finalize" | "voidExpired" };

/**
 * Decide which on-chain actions are due. Pure and deterministic.
 *  - Proposed and past its challenge window  -> finalize
 *  - Active and past its TTL                  -> voidExpired
 */
export function keeperActions(matches: KeeperMatch[], now: number): KeeperAction[] {
  const out: KeeperAction[] = [];
  for (const m of matches) {
    if (m.status === EscrowStatus.Proposed && now > m.challengeDeadline) {
      out.push({ matchId: m.matchId, action: "finalize" });
    } else if (m.status === EscrowStatus.Active && m.activeDeadline > 0 && now > m.activeDeadline) {
      out.push({ matchId: m.matchId, action: "voidExpired" });
    }
  }
  return out;
}

/** Execute keeper actions, returning the submitted transaction hashes. */
export async function runKeeper(client: SettlementClient, actions: KeeperAction[]): Promise<Hex[]> {
  const hashes: Hex[] = [];
  for (const a of actions) {
    hashes.push(a.action === "finalize" ? await client.finalize(a.matchId) : await client.voidExpired(a.matchId));
  }
  return hashes;
}
