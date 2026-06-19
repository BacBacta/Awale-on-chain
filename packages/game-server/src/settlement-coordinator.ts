// Collects both players' result signatures at game end and submits settleSigned.
//
// The server never holds session keys, so on game-over each client signs the
// EIP-712 Result(matchId, winner) with its session key and sends it here. The
// coordinator recovers each signer, maps it to player 0/1 via the match's
// registered session keys, and once both are in, calls settleSigned through the
// funded server signer.

import { recoverAddress, type Address, type Hex } from "viem";
import { resultDigest } from "./eip712.js";
import type { GameHub } from "./hub.js";
import type { SettlementClient } from "./chain.js";

export interface SettlementCoordinatorOptions {
  escrow: Address;
  chainId: bigint;
  settlement?: SettlementClient; // omitted in read-only mode
}

export type SubmitOutcome = "ignored" | "collected" | "settled";

export class SettlementCoordinator {
  private readonly pending = new Map<string, { winner: number; sig0?: Hex; sig1?: Hex }>();

  constructor(private readonly opts: SettlementCoordinatorOptions) {}

  /** Accept a result signature; settle once both players have signed. */
  async submit(hub: GameHub, matchId: bigint, signature: Hex): Promise<SubmitOutcome> {
    const match = hub.get(matchId);
    if (!match || !match.over) return "ignored";

    const winner = match.result().winner;
    const digest = resultDigest(matchId, winner, { chainId: this.opts.chainId, escrow: this.opts.escrow });
    const signer = await recoverAddress({ hash: digest, signature });

    const [s0, s1] = match.cfg.sessions;
    const player = signer.toLowerCase() === s0.toLowerCase() ? 0 : signer.toLowerCase() === s1.toLowerCase() ? 1 : -1;
    if (player < 0) return "ignored";

    const key = matchId.toString();
    let entry = this.pending.get(key);
    if (!entry) this.pending.set(key, (entry = { winner }));
    if (player === 0) entry.sig0 = signature;
    else entry.sig1 = signature;

    if (entry.sig0 && entry.sig1) {
      if (this.opts.settlement) {
        await this.opts.settlement.settleSigned(matchId, winner, entry.sig0, entry.sig1);
      }
      this.pending.delete(key);
      hub.close(matchId);
      return "settled";
    }
    return "collected";
  }
}
