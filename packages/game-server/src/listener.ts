// On-chain → hub glue: when a match becomes Active on-chain (both players have
// joined and registered their session keys), open it in the GameHub so the
// server can sequence its moves.
//
// The session keys and first mover live in the contract, not the join event, so
// a join is observed and then the match record is read back. The core mapping is
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
}

/** Open a match in the hub from its on-chain record. Returns the room id. */
export function openMatchFromChain(hub: GameHub, m: ChainMatch, ctx: MatchContext): string {
  return hub.open({
    matchId: m.matchId,
    chainId: ctx.chainId,
    verifier: ctx.verifier,
    sessions: [m.session0, m.session1],
    startTurn: m.startTurn === 1 ? 1 : 0,
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
      { name: "startTurn", type: "uint8", indexed: false },
    ],
  },
] as const;

/**
 * Watch MatchJoined and open each newly-active match in the hub. `readMatch`
 * is injected (reads the contract's session keys + startTurn for a matchId) so
 * this stays decoupled from a specific transport. Returns an unsubscribe fn.
 */
export function watchMatchJoined(
  client: EventWatcher,
  opts: { escrow: Address; ctx: MatchContext; readMatch: (matchId: bigint) => Promise<ChainMatch> },
  hub: GameHub,
): () => void {
  return client.watchContractEvent({
    address: opts.escrow,
    abi: matchJoinedAbi,
    eventName: "MatchJoined",
    onLogs: (logs) => {
      for (const log of logs) {
        const matchId = log.args.matchId;
        if (matchId === undefined) continue;
        void opts.readMatch(matchId).then((m) => openMatchFromChain(hub, m, opts.ctx));
      }
    },
  });
}
