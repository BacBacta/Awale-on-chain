// Collects both players' result signatures at game end and submits settleSigned.
//
// The server never holds session keys, so on game-over each client signs the
// EIP-712 Result(matchId, winner) with its session key and sends it here. The
// coordinator recovers each signer, maps it to player 0/1 via the match's
// registered session keys, and once both are in, calls settleSigned through the
// funded server signer.
//
// Abandonment / refusal fallback: a finished game whose loser never signs would
// otherwise strand the winner's stake. On game-over we arm a timer; if both
// signatures haven't arrived in time, the server calls proposeResult with the
// real transcript's commitment. After the challenge window a keeper finalizes,
// paying the rightful winner; a challenge that replays the same transcript only
// confirms that winner (a mismatching/partial transcript is rejected).

import { recoverAddress, type Address, type Hex } from "viem";
import { resultDigest } from "./eip712.js";
import type { GameHub } from "./hub.js";
import type { SettlementClient } from "./chain.js";

export interface SettlementCoordinatorOptions {
  escrow: Address;
  chainId: bigint;
  settlement?: SettlementClient; // omitted in read-only mode
  /** How long to wait for both signatures before proposing on-chain. */
  proposeAfterMs?: number;
}

export type SubmitOutcome = "ignored" | "collected" | "settled";

const DEFAULT_PROPOSE_AFTER_MS = 45_000;

export class SettlementCoordinator {
  private readonly pending = new Map<string, { winner: number; sig0?: Hex; sig1?: Hex }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly proposed = new Set<string>();

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
      this.cancelFallback(key);
      if (this.opts.settlement) {
        await this.opts.settlement.settleSigned(matchId, winner, entry.sig0, entry.sig1);
      }
      this.pending.delete(key);
      hub.close(matchId);
      return "settled";
    }
    return "collected";
  }

  /**
   * Arm the abandonment fallback for a freshly-finished match. If both result
   * signatures aren't collected within `proposeAfterMs`, propose the terminal
   * result on-chain (committing to the real transcript) so the winner can be paid.
   */
  armProposalFallback(hub: GameHub, matchId: bigint, winner: number): void {
    if (!this.opts.settlement) return; // read-only server can't propose
    const key = matchId.toString();
    if (this.timers.has(key) || this.proposed.has(key)) return;

    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.propose(hub, matchId, winner);
    }, this.opts.proposeAfterMs ?? DEFAULT_PROPOSE_AFTER_MS);
    if (typeof timer === "object" && "unref" in timer) timer.unref?.();
    this.timers.set(key, timer);
  }

  private cancelFallback(key: string): void {
    const t = this.timers.get(key);
    if (t) {
      clearTimeout(t);
      this.timers.delete(key);
    }
  }

  private async propose(hub: GameHub, matchId: bigint, winner: number): Promise<void> {
    const key = matchId.toString();
    if (this.proposed.has(key) || !this.opts.settlement) return;
    const match = hub.get(matchId);
    if (!match || !match.over) return; // already settled & closed, or not actually over
    this.proposed.add(key);
    try {
      await this.opts.settlement.proposeResult(matchId, winner, match.transcript());
      hub.close(matchId);
    } catch (err) {
      this.proposed.delete(key); // allow a retry on the next trigger
      throw err;
    }
  }
}
