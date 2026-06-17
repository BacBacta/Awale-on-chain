// Live-match registry: the transport-agnostic core the Socket.IO layer drives.
//
// The hub owns the set of in-progress Matches and the matchmaking queue. It is
// deliberately free of any network code so it can be unit-tested; `server.ts`
// wires it to Socket.IO.

import { Match, type MatchConfig, type Transcript } from "./match.js";
import { Matchmaker, type Player, type Pairing } from "./matchmaking.js";
import type { GameState } from "../../engine/src/awale.js";

export class GameHub {
  private readonly matches = new Map<string, Match>();
  readonly matchmaker: Matchmaker;

  constructor(matchmaker = new Matchmaker()) {
    this.matchmaker = matchmaker;
  }

  /** Queue a player for ranked play; returns a Pairing when one is found. */
  queue(player: Omit<Player, "enqueuedAt">): Pairing | null {
    return this.matchmaker.enqueue(player);
  }

  /** Register a funded match (config read from the on-chain join events). */
  open(cfg: MatchConfig): string {
    const id = cfg.matchId.toString();
    if (this.matches.has(id)) throw new Error("match already open");
    this.matches.set(id, new Match(cfg));
    return id;
  }

  get(matchId: bigint): Match | undefined {
    return this.matches.get(matchId.toString());
  }

  /** Apply a signed move; throws (and the caller rejects) on any invalid move. */
  async move(matchId: bigint, player: 0 | 1, house: number, signature: `0x${string}`): Promise<GameState> {
    const m = this.matches.get(matchId.toString());
    if (!m) throw new Error("no such match");
    return m.submitMove(player, house, signature);
  }

  /** The transcript for a match (for dispute) and whether it has ended. */
  transcript(matchId: bigint): Transcript | undefined {
    return this.matches.get(matchId.toString())?.transcript();
  }

  /** Drop a finished match from memory once it has been settled. */
  close(matchId: bigint): void {
    this.matches.delete(matchId.toString());
  }

  get activeCount(): number {
    return this.matches.size;
  }
}
