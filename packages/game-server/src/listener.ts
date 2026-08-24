// On-chain → hub glue. A match opens for play only once its first mover is
// fixed. The flip is a two-party commit–reveal settled off the wire, so the
// lifecycle is two events:
//
//   MatchJoined(matchId)               -> both staked AND both committed; the
//                                         players may now safely reveal
//   StartFinalized(matchId, startTurn) -> the flip is fixed; open the match
//
// The session keys + final startTurn live in the contract, so a finalize is
// observed and then the match record is read back. The core mapping is
// pure/testable; the viem event-watching is a thin integration wrapper.

import type { Address } from "viem";
import { GameHub } from "./hub.js";

export interface ChainMatch {
  matchId: bigint;
  session0: Address;
  session1: Address;
  startTurn: number;
}

export interface MatchContext {
  chainId: bigint;
  verifier: Address;
  /** Blitz: total thinking time per player (see MatchConfig.clockMs). */
  clockMs?: number;
}

/** Open a match in the hub from its on-chain record. Returns the room id. */
export function openMatchFromChain(hub: GameHub, m: ChainMatch, ctx: MatchContext): string {
  return hub.open({
    matchId: m.matchId,
    chainId: ctx.chainId,
    verifier: ctx.verifier,
    sessions: [m.session0, m.session1],
    startTurn: m.startTurn === 1 ? 1 : 0,
    clockMs: ctx.clockMs,
  });
}

/** Minimal watcher surface satisfied structurally by a viem PublicClient. */
export interface EventWatcher {
  watchContractEvent(args: {
    address: Address;
    abi: readonly unknown[];
    eventName: string;
    onLogs: (logs: { args: { matchId?: bigint } }[]) => void;
  }): () => void;
}

const matchJoinedAbi = [
  {
    type: "event",
    name: "MatchJoined",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "player1", type: "address", indexed: true },
    ],
  },
] as const;

const startFinalizedAbi = [
  {
    type: "event",
    name: "StartFinalized",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "startTurn", type: "uint8", indexed: false },
    ],
  },
] as const;

/**
 * Watch StartFinalized and open each match in the hub once its first mover is
 * fixed. `readMatch` is injected (reads the contract's session keys + startTurn
 * for a matchId) so this stays decoupled from a specific transport. Returns an
 * unsubscribe fn.
 */
export function watchStartFinalized(
  client: EventWatcher,
  opts: { escrow: Address; ctx: MatchContext; readMatch: (matchId: bigint) => Promise<ChainMatch> },
  hub: GameHub,
): () => void {
  return client.watchContractEvent({
    address: opts.escrow,
    abi: startFinalizedAbi,
    eventName: "StartFinalized",
    onLogs: (logs) => {
      for (const log of logs) {
        const matchId = log.args.matchId;
        if (matchId === undefined) continue;
        void opts
          .readMatch(matchId)
          .then((m) => openMatchFromChain(hub, m, opts.ctx))
          .catch(() => {
            /* hub already has it (hydration won the race) or the read gave up */
          });
      }
    },
  });
}

/**
 * Watch MatchJoined and drive each match's first mover to being fixed.
 *
 * MatchJoined is the moment BOTH commitments are on chain, which is exactly
 * when revealing becomes safe — before it, player 1 has not committed and an
 * early secret0 would let them grind their own to choose who starts. `finalize`
 * submits the pair once both players have revealed; it is a no-op until then,
 * so it is safe to call eagerly and to retry. Returns an unsubscribe fn.
 */
export function watchMatchJoined(
  client: EventWatcher,
  opts: { escrow: Address; finalize: (matchId: bigint) => Promise<void> },
): () => void {
  return client.watchContractEvent({
    address: opts.escrow,
    abi: matchJoinedAbi,
    eventName: "MatchJoined",
    onLogs: (logs) => {
      for (const log of logs) {
        const matchId = log.args.matchId;
        if (matchId === undefined) continue;
        void opts.finalize(matchId);
      }
    },
  });
}
