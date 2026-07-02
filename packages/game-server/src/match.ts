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

import { initialState, applyMove, legalMovesMask, DRAW, type GameState } from "../../engine/src/awale.js";
import { moveDigest, resignDigest, drawOfferDigest, type MoveContext } from "./eip712.js";
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
  /** Set when the match ended some way that isn't a move — forfeit, resign,
   *  or a mutual draw accept — so rehydrating (a pure move-replay) doesn't
   *  silently forget it. Absent for a match still in progress or one that
   *  ended naturally (replaying the moves already reaches `over`). */
  terminal?: { winner: number };
}

export class Match {
  readonly cfg: MatchConfig;
  state: GameState;
  private readonly _moves: number[] = [];
  private readonly _sigs: Hex[] = [];
  private _drawOffer?: 0 | 1;
  /** When the player currently on turn became on turn — the move-clock's start. */
  private _turnStartedAt: number;

  constructor(cfg: MatchConfig, now: () => number = Date.now) {
    this.cfg = cfg;
    this.state = initialState();
    this.state.turn = cfg.startTurn;
    this._now = now;
    this._turnStartedAt = now();
  }

  private readonly _now: () => number;

  get over(): boolean {
    return this.state.over;
  }

  get ply(): number {
    return this._moves.length;
  }

  get turn(): number {
    return this.state.turn;
  }

  /** How long the current mover has had the turn — the basis for a move-clock timeout. */
  msSinceTurnStart(): number {
    return this._now() - this._turnStartedAt;
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
    this._turnStartedAt = this._now(); // the clock hands off to whoever moves next
    return next;
  }

  /**
   * A player unilaterally concedes; the opponent wins. Only the resigning
   * player's own signature is required — a player can only give away their
   * own win, never anyone else's, so this needs no extra trust beyond a
   * normal move signature.
   */
  async resign(player: 0 | 1, signature: Hex): Promise<GameState> {
    if (this.state.over) throw new Error("match over");
    const digest = resignDigest(this.cfg.matchId, BigInt(this.ply), this.ctx());
    const signer = await recoverAddress({ hash: digest, signature });
    if (signer.toLowerCase() !== this.cfg.sessions[player].toLowerCase()) {
      throw new Error("bad resign signature");
    }
    this.state = { ...this.state, over: true, winner: (1 - player) as 0 | 1 };
    return this.state;
  }

  /**
   * Server-declared forfeit: no signature, because the mover's move-clock ran
   * out — there's no choice being made for them to sign. Callers must only use
   * this where an unsigned server verdict is safe (no on-chain stake riding on
   * it); casual/off-chain play only. Staked matches settle a clock timeout
   * on-chain instead (see server.ts's "claim-eligible" signal).
   */
  forfeit(disconnectedPlayer: 0 | 1): GameState {
    if (this.state.over) throw new Error("match over");
    this.state = { ...this.state, over: true, winner: (1 - disconnectedPlayer) as 0 | 1 };
    return this.state;
  }

  /** Offer a mutual draw; held until the opponent accepts (or the match ends). */
  async offerDraw(player: 0 | 1, signature: Hex): Promise<void> {
    if (this.state.over) throw new Error("match over");
    const digest = drawOfferDigest(this.cfg.matchId, BigInt(this.ply), this.ctx());
    const signer = await recoverAddress({ hash: digest, signature });
    if (signer.toLowerCase() !== this.cfg.sessions[player].toLowerCase()) {
      throw new Error("bad draw-offer signature");
    }
    this._drawOffer = player;
  }

  /** Accept the opponent's pending draw offer; the match ends in a draw. */
  async acceptDraw(player: 0 | 1, signature: Hex): Promise<GameState> {
    if (this.state.over) throw new Error("match over");
    if (this._drawOffer === undefined || this._drawOffer === player) {
      throw new Error("no pending draw offer from the opponent");
    }
    const digest = drawOfferDigest(this.cfg.matchId, BigInt(this.ply), this.ctx());
    const signer = await recoverAddress({ hash: digest, signature });
    if (signer.toLowerCase() !== this.cfg.sessions[player].toLowerCase()) {
      throw new Error("bad draw-offer signature");
    }
    this._drawOffer = undefined;
    this.state = { ...this.state, over: true, winner: DRAW };
    return this.state;
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
      // redundant (but harmless) for a natural ending — load-bearing for
      // forfeit/resign/draw, which replaying the move list alone can't reach.
      terminal: this.state.over ? { winner: this.state.winner } : undefined,
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
    // A forfeit/resign/draw-accept ends the match without a move, so replaying
    // the moves alone can't reach it — apply the recorded outcome directly.
    if (snap.terminal && !m.state.over) {
      m.state = { ...m.state, over: true, winner: snap.terminal.winner };
    }
    return m;
  }
}
