// Async / correspondence matches: play a move, persist, notify the opponent —
// neither player needs to be online at the same time. Built on the same engine
// + session-key verification as live play (Match), so an async transcript is
// just as disputable on-chain.

import type { Address, Hex } from "viem";
import { Match, type MatchSnapshot } from "./match.js";
import type { GameState } from "../../engine/src/awale.js";
import type { MatchStore } from "./persistence/store.js";
import type { Notifier } from "./notifications/notifier.js";

export interface AsyncMatchSummary {
  matchId: string;
  turn: number;
  over: boolean;
  ply: number;
  yourTurn: boolean;
  opponent: Address;
  mode: "casual" | "cash";
  updatedAt: number;
}

export interface AsyncMatchState {
  matchId: string;
  state: GameState;
  turn: number;
  over: boolean;
  ply: number;
  players: [Address, Address];
  /** true while waiting for a second player to join (correspondence invite). */
  open: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export class AsyncMatchService {
  constructor(
    private readonly store: MatchStore,
    private readonly notifier: Notifier,
  ) {}

  /** Open a new async match. Returns the match id. */
  async create(opts: {
    matchId: bigint;
    chainId: bigint;
    verifier: Address;
    sessions: [Address, Address];
    players: [Address, Address];
    startTurn: 0 | 1;
    mode: "casual" | "cash";
  }): Promise<string> {
    const m = new Match({
      matchId: opts.matchId,
      chainId: opts.chainId,
      verifier: opts.verifier,
      sessions: opts.sessions,
      startTurn: opts.startTurn,
    });
    await this.store.save({
      snapshot: m.snapshot(),
      players: opts.players,
      mode: opts.mode,
      turn: m.turn,
      over: m.over,
      ply: m.ply,
      updatedAt: Date.now(),
    });
    return opts.matchId.toString();
  }

  /**
   * Open a correspondence match with only the creator; a second player joins via
   * an invite link. Returns the match id.
   */
  async createOpen(opts: {
    matchId: bigint;
    chainId: bigint;
    verifier: Address;
    creator: Address;
    session0: Address;
    startTurn: 0 | 1;
    mode: "casual" | "cash";
  }): Promise<string> {
    const m = new Match({
      matchId: opts.matchId,
      chainId: opts.chainId,
      verifier: opts.verifier,
      sessions: [opts.session0, ZERO],
      startTurn: opts.startTurn,
    });
    await this.store.save({
      snapshot: m.snapshot(),
      players: [opts.creator, ZERO],
      mode: opts.mode,
      turn: m.turn,
      over: m.over,
      ply: m.ply,
      updatedAt: Date.now(),
    });
    return opts.matchId.toString();
  }

  /** Second player joins an open match (binds their session key). */
  async join(matchId: string, joiner: Address, session1: Address): Promise<AsyncMatchState> {
    const rec = await this.store.get(matchId);
    if (!rec) throw new Error("no such match");
    if (rec.players[1] !== ZERO) throw new Error("match already full");
    if (rec.players[0].toLowerCase() === joiner.toLowerCase()) throw new Error("cannot join your own game");
    rec.players[1] = joiner;
    rec.snapshot.session1 = session1;
    rec.updatedAt = Date.now();
    await this.store.save(rec);
    return (await this.getState(matchId))!;
  }

  /** Current replayed state of a match (null if unknown). */
  async getState(matchId: string): Promise<AsyncMatchState | null> {
    const rec = await this.store.get(matchId);
    if (!rec) return null;
    const m = Match.rehydrate(rec.snapshot);
    return { matchId, state: m.state, turn: m.turn, over: m.over, ply: m.ply, players: rec.players, open: rec.players[1] === ZERO };
  }

  /**
   * Apply a session-key-signed move, persist, and notify the opponent if the
   * game continues. Reuses Match.submitMove (engine legality + signature check).
   */
  async move(matchId: string, player: 0 | 1, house: number, signature: Hex): Promise<GameState> {
    const rec = await this.store.get(matchId);
    if (!rec) throw new Error("no such match");
    const m = Match.rehydrate(rec.snapshot);
    const next = await m.submitMove(player, house, signature);

    await this.store.save({
      snapshot: m.snapshot(),
      players: rec.players,
      mode: rec.mode,
      turn: m.turn,
      over: m.over,
      ply: m.ply,
      updatedAt: Date.now(),
    });

    if (!m.over) {
      const opponent = rec.players[1 - player];
      await this.notifier.notifyTurn(opponent, matchId);
    }
    return next;
  }

  /** A player's matches, with whose-turn flagged. */
  async listForPlayer(address: Address): Promise<AsyncMatchSummary[]> {
    const recs = await this.store.listForPlayer(address);
    const me = address.toLowerCase();
    return recs.map((rec) => {
      const role = rec.players[0].toLowerCase() === me ? 0 : 1;
      return {
        matchId: rec.snapshot.matchId.toString(),
        turn: rec.turn,
        over: rec.over,
        ply: rec.ply,
        yourTurn: !rec.over && rec.turn === role,
        opponent: rec.players[1 - role],
        mode: rec.mode,
        updatedAt: rec.updatedAt,
      };
    });
  }
}

export type { MatchSnapshot };
