// Authoritative match orchestration.
//
// The server is authoritative over *sequencing* but never over *moves*: it does
// not hold the session keys, so it cannot forge or alter a move. Each submitted
// move must carry a signature by the mover's per-match session key over the
// exact on-chain move digest; the server verifies it, then applies the move
// through the shared, parity-proven rule engine (which rejects illegal moves).
//
// The accumulated (moves, signatures) form the transcript that ReplayVerifier
// would replay on-chain in a dispute, so what the server accepts is exactly what
// the contract would accept.

import { initialState, applyMove, legalMovesMask, type GameState } from "../../engine/src/awale.js";
import { moveDigest, type MoveContext } from "./eip712.js";
import { recoverAddress, type Address, type Hex } from "viem";

export interface MatchConfig {
  matchId: bigint;
  chainId: bigint;
  verifier: Address; // ReplayVerifier address (domain for move signatures)
  sessions: [Address, Address]; // session key of player 0 and player 1
  startTurn: 0 | 1;
}

export interface Transcript {
  matchId: bigint;
  session0: Address;
  session1: Address;
  startTurn: 0 | 1;
  moves: number[];
  sigs: Hex[];
}

/** Serializable form of a live match, for persistence + rehydration. */
export interface MatchSnapshot {
  matchId: bigint;
  chainId: bigint;
  verifier: Address;
  session0: Address;
  session1: Address;
  startTurn: 0 | 1;
  moves: number[];
  sigs: Hex[];
}

export class Match {
  readonly cfg: MatchConfig;
  state: GameState;
  private readonly _moves: number[] = [];
  private readonly _sigs: Hex[] = [];

  constructor(cfg: MatchConfig) {
    this.cfg = cfg;
    this.state = initialState();
    this.state.turn = cfg.startTurn;
  }

  get over(): boolean {
    return this.state.over;
  }

  get ply(): number {
    return this._moves.length;
  }

  get turn(): number {
    return this.state.turn;
  }

  /** Houses (0..5) the current player may legally play. */
  legalMoves(): number[] {
    const mask = legalMovesMask(this.state);
    const out: number[] = [];
    for (let h = 0; h < 6; h++) if (mask & (1 << h)) out.push(h);
    return out;
  }

  private ctx(): MoveContext {
    return { chainId: this.cfg.chainId, verifier: this.cfg.verifier };
  }

  /**
   * Submit a signed move. Throws on: game over, wrong player's turn, a signature
   * not from that player's session key, or an illegal move (engine-enforced).
   * Returns the new state on success.
   */
  async submitMove(player: 0 | 1, house: number, signature: Hex): Promise<GameState> {
    if (this.state.over) throw new Error("match over");
    if (player !== this.state.turn) throw new Error("not your turn");

    const digest = moveDigest(this.cfg.matchId, BigInt(this.ply), house, this.ctx());
    const signer = await recoverAddress({ hash: digest, signature });
    if (signer.toLowerCase() !== this.cfg.sessions[player].toLowerCase()) {
      throw new Error("bad move signature");
    }

    // engine validates legality and reverts otherwise — no illegal move is kept
    const next = applyMove(this.state, house);
    this.state = next;
    this._moves.push(house);
    this._sigs.push(signature);
    return next;
  }

  /** The dispute transcript, ready to pass to ReplayVerifier.verify. */
  transcript(): Transcript {
    return {
      matchId: this.cfg.matchId,
      session0: this.cfg.sessions[0],
      session1: this.cfg.sessions[1],
      startTurn: this.cfg.startTurn,
      moves: [...this._moves],
      sigs: [...this._sigs],
    };
  }

  /** Final outcome, valid once `over`. winner: 0, 1, or 2 (draw). */
  result(): { over: boolean; winner: number } {
    return { over: this.state.over, winner: this.state.winner };
  }

  /** Serializable snapshot for persistence (Redis live state). */
  snapshot(): MatchSnapshot {
    return {
      matchId: this.cfg.matchId,
      chainId: this.cfg.chainId,
      verifier: this.cfg.verifier,
      session0: this.cfg.sessions[0],
      session1: this.cfg.sessions[1],
      startTurn: this.cfg.startTurn,
      moves: [...this._moves],
      sigs: [...this._sigs],
    };
  }

  /** Rebuild a Match from a snapshot by replaying its (already-accepted) moves. */
  static rehydrate(snap: MatchSnapshot): Match {
    const m = new Match({
      matchId: snap.matchId,
      chainId: snap.chainId,
      verifier: snap.verifier,
      sessions: [snap.session0, snap.session1],
      startTurn: snap.startTurn,
    });
    for (let i = 0; i < snap.moves.length; i++) {
      m.state = applyMove(m.state, snap.moves[i]);
      m._moves.push(snap.moves[i]);
      m._sigs.push(snap.sigs[i]);
    }
    return m;
  }
}
