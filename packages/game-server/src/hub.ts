// Live-match registry: the transport-agnostic core the Socket.IO layer drives.
//
// The hub owns the set of in-progress Matches and the matchmaking queue. It is
// deliberately free of any network code so it can be unit-tested; `server.ts`
// wires it to Socket.IO.
//
// Snapshots: when a LiveMatchStore is provided, every state mutation persists
// the match (moves + signatures included). Before this, the hub was purely
// in-memory: a deploy mid-game LOST the signed transcript, so a staked match
// could neither settle (settleSigned) nor be disputed (challenge) — money
// locked until the TTL void. Saves are fire-and-forget: persistence must
// never slow or fail a move.

import { Match, type MatchConfig, type MatchSnapshot, type Transcript } from "./match.js";
import { Matchmaker, type Player, type Pairing } from "./matchmaking.js";
import type { LiveMatchStore } from "./store/types.js";
import type { GameState } from "../../engine/src/awale.js";

export class GameHub {
  private readonly matches = new Map<string, Match>();
  readonly matchmaker: Matchmaker;
  private readonly store?: LiveMatchStore;

  constructor(matchmaker = new Matchmaker(), store?: LiveMatchStore) {
    this.matchmaker = matchmaker;
    this.store = store;
  }

  private persist(m: Match): void {
    void this.store?.save(m.snapshot()).catch(() => {});
  }

  /** Queue a player for ranked play; returns a Pairing when one is found. */
  queue(player: Omit<Player, "enqueuedAt">): Pairing | null {
    return this.matchmaker.enqueue(player);
  }

  /** Register a funded match (config read from the on-chain join events). */
  open(cfg: MatchConfig): string {
    const id = cfg.matchId.toString();
    if (this.matches.has(id)) throw new Error("match already open");
    const m = new Match(cfg);
    this.matches.set(id, m);
    this.persist(m);
    return id;
  }

  /** Re-insert a match from a persisted snapshot (crash/deploy recovery) —
   *  replays the already-accepted moves so the signed transcript is intact. */
  restore(snap: MatchSnapshot): string {
    const m = Match.rehydrate(snap);
    const id = snap.matchId.toString();
    this.matches.set(id, m);
    return id;
  }

  get(matchId: bigint): Match | undefined {
    return this.matches.get(matchId.toString());
  }

  /** Apply a signed move; throws (and the caller rejects) on any invalid move. */
  async move(matchId: bigint, player: 0 | 1, house: number, signature: `0x${string}`): Promise<GameState> {
    const m = this.matches.get(matchId.toString());
    if (!m) throw new Error("no such match");
    const state = await m.submitMove(player, house, signature);
    this.persist(m);
    return state;
  }

  /** A player concedes; the opponent wins. */
  async resign(matchId: bigint, player: 0 | 1, signature: `0x${string}`): Promise<GameState> {
    const m = this.matches.get(matchId.toString());
    if (!m) throw new Error("no such match");
    const state = await m.resign(player, signature);
    this.persist(m);
    return state;
  }

  /** Offer a mutual draw to the opponent. */
  async offerDraw(matchId: bigint, player: 0 | 1, signature: `0x${string}`): Promise<void> {
    const m = this.matches.get(matchId.toString());
    if (!m) throw new Error("no such match");
    return m.offerDraw(player, signature);
  }

  /** Accept the opponent's pending draw offer. */
  async acceptDraw(matchId: bigint, player: 0 | 1, signature: `0x${string}`): Promise<GameState> {
    const m = this.matches.get(matchId.toString());
    if (!m) throw new Error("no such match");
    const state = await m.acceptDraw(player, signature);
    this.persist(m);
    return state;
  }

  /** Server-declared forfeit (move-clock expired, casual play only) — unsigned. */
  forfeit(matchId: bigint, disconnectedPlayer: 0 | 1): GameState {
    const m = this.matches.get(matchId.toString());
    if (!m) throw new Error("no such match");
    const state = m.forfeit(disconnectedPlayer);
    this.persist(m);
    return state;
  }

  /** The transcript for a match (for dispute) and whether it has ended. */
  transcript(matchId: bigint): Transcript | undefined {
    return this.matches.get(matchId.toString())?.transcript();
  }

  /** Drop a finished match from memory (and the snapshot store) once settled. */
  close(matchId: bigint): void {
    this.matches.delete(matchId.toString());
    void this.store?.remove(matchId).catch(() => {});
  }

  get activeCount(): number {
    return this.matches.size;
  }
}
