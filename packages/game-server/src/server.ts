// Socket.IO transport (integration layer).
//
// Thin wiring from socket events to the GameHub. All authoritative logic lives
// in the hub/Match/engine; this file only translates messages.
//
// Protocol (client -> server):
//   "queue"      { address, elo, mode? }                    join matchmaking ("casual"
//                                                            by default; "ranked"/"cash"
//                                                            require personhood verification)
//   "watch"          { matchId, player? }                   subscribe to a match room
//   "move"           { matchId, player, house, signature } a session-key-signed move
//   "result-sig"     { matchId, signature }                a session-key-signed result
//   "resign"         { matchId, player, signature }        concede; opponent wins
//   "draw-offer"      { matchId, player, signature }        offer a mutual draw
//   "draw-accept"     { matchId, player, signature }        accept the pending draw offer
//   "get-transcript"  { matchId }                           fetch the signed transcript (still
//                                                           in memory) to decide whether to dispute
// Server -> client:
//   "matched"        { opponent }
//   "state"          { matchId, state, ply }
//   "gameover"       { matchId, winner }
//   "settled"        { matchId }
//   "draw-offer"     { matchId, from }                      relayed to the opponent
//   "claim-eligible" { matchId, winner, transcript }        staked only — the opponent's
//                                                           move-clock ran out, or a natural
//                                                           ending never settled; whoever the
//                                                           `winner` is can call proposeResult
//   "transcript"     { matchId, transcript }                reply to "get-transcript"
//   "error"          { message }
//
// Move-clock rule (one mental model everywhere): a player has a fixed window
// to play their turn. Miss it and you forfeit. For casual play the server
// declares the winner directly (no stake, no signature needed). For staked
// play the server never decides who loses a stake — it only signals; a
// player still has to claim on-chain via MatchEscrow.proposeResult (from
// their own wallet), which opens the existing challenge window before paying
// out. See docs/deployment.md and MatchEscrow.sol for that on-chain half.

import type { Server, Socket } from "socket.io";
import type { Address, Hex } from "viem";
import { GameHub } from "./hub.js";
import type { Match, Transcript } from "./match.js";
import type { SettlementCoordinator } from "./settlement-coordinator.js";
import { assertPersonhood } from "./personhood/gate.js";
import type { PersonhoodRegistry, PlayMode } from "./personhood/types.js";
import type { GameState } from "../../engine/src/awale.js";

export interface ServerDeps {
  hub: GameHub;
  /** Collects result signatures and submits settleSigned (optional). */
  coordinator?: SettlementCoordinator;
  /** Called when a game ends so the app can react. */
  onGameOver?: (matchId: bigint, winner: number) => void;
  /** Gates ranked/cash matchmaking behind Self proof-of-personhood (optional). */
  personhood?: PersonhoodRegistry;
  /** Domain for casual (off-chain) quick-match move signatures. */
  casualCtx?: { chainId: bigint; verifier: Address };
  /** Per-turn move-clock for live play (default 2 minutes). */
  turnClockMs?: number;
  /** Blitz: total thinking time per player for live matches (default 3 min) —
   *  bounds a game to ~6 minutes, matching the audience's short-round rhythm. */
  blitzClockMs?: number;
  /** How long to wait for the two-signature fast path before telling a staked
   *  winner to self-claim on-chain (default 45s). */
  unsettledWatchdogMs?: number;
  /** Called when a casual quick-match ends, with both wallet addresses —
   *  feeds Elo + win/played counters on the durable player profile. */
  onResult?: (players: [Address, Address], winner: number) => void;
}

/** A fresh, collision-free id for an off-chain casual match (also used for async). */
function casualMatchId(): bigint {
  return (1n << 200n) + BigInt(Math.floor(Math.random() * 1e15)) * 1000n + BigInt(Math.floor(Math.random() * 1000));
}

// Any matchId in this range is a synthetic off-chain id (casual quick-match or
// async) — never a real MatchEscrow id, which comes from the contract's small,
// sequential nextMatchId() counter. This is how the server tells "no money
// riding on this" apart from "money riding on this" without extra bookkeeping.
const CASUAL_ID_FLOOR = 1n << 200n;
function isCasualMatch(matchId: bigint): boolean {
  return matchId >= CASUAL_ID_FLOOR;
}

const DEFAULT_TURN_CLOCK_MS = 2 * 60_000;
const DEFAULT_BLITZ_CLOCK_MS = 3 * 60_000;
const DEFAULT_UNSETTLED_WATCHDOG_MS = 45_000;

export function attachSocketIO(io: Server, deps: ServerDeps): void {
  const { hub } = deps;
  const TURN_CLOCK_MS = deps.turnClockMs ?? DEFAULT_TURN_CLOCK_MS;
  const BLITZ_CLOCK_MS = deps.blitzClockMs ?? DEFAULT_BLITZ_CLOCK_MS;
  const UNSETTLED_WATCHDOG_MS = deps.unsettledWatchdogMs ?? DEFAULT_UNSETTLED_WATCHDOG_MS;

  // One move-clock timer per live match, keyed by room id (matchId.toString()).
  const turnClockTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Casual quick-match seats by room id — the wallet addresses behind player 0
  // and 1, known only at pairing time. Lets a finished game feed the durable
  // player profiles (Elo, played/won). Entries die with the match.
  const casualPlayers = new Map<string, [Address, Address]>();

  function clearTurnClock(roomId: string): void {
    const t = turnClockTimers.get(roomId);
    if (t) {
      clearTimeout(t);
      turnClockTimers.delete(roomId);
    }
  }

  /** ms until the current mover times out: the per-move window or their total
   *  blitz bank, whichever runs dry first. */
  function msUntilExpiry(m: Match): number {
    const perMove = TURN_CLOCK_MS - m.msSinceTurnStart();
    const total = m.clockRemainingMs(m.turn as 0 | 1);
    return Math.max(0, total === null ? perMove : Math.min(perMove, total));
  }

  /** (Re)schedule the clock against however much time the current mover has left. */
  function scheduleTurnClock(matchId: bigint, roomId: string, m: Match): void {
    const timer = setTimeout(() => onTurnClockExpired(matchId, roomId), msUntilExpiry(m));
    if ("unref" in timer) timer.unref?.();
    turnClockTimers.set(roomId, timer);
  }

  /** Idempotent: arms the clock the first time anyone touches a match (e.g. on
   *  "watch"), including the catch-up case where it should already have fired. */
  function armTurnClockIfNeeded(matchId: bigint, roomId: string): void {
    if (turnClockTimers.has(roomId)) return;
    const m = hub.get(matchId);
    if (!m || m.over) return;
    scheduleTurnClock(matchId, roomId, m);
  }

  /** Always resets — used after a move, since a fresh turn just started. */
  function rearmTurnClock(matchId: bigint, roomId: string): void {
    clearTurnClock(roomId);
    const m = hub.get(matchId);
    if (!m || m.over) return;
    scheduleTurnClock(matchId, roomId, m);
  }

  function onTurnClockExpired(matchId: bigint, roomId: string): void {
    turnClockTimers.delete(roomId);
    const m = hub.get(matchId);
    if (!m || m.over) return;
    if (msUntilExpiry(m) > 0) {
      // a race with a move that landed just as this fired — reschedule defensively
      scheduleTurnClock(matchId, roomId, m);
      return;
    }
    const timedOutPlayer = m.turn as 0 | 1;
    if (isCasualMatch(matchId)) {
      try {
        const state = hub.forfeit(matchId, timedOutPlayer);
        announceGameOver(matchId, roomId, state);
      } catch {
        /* already resolved some other way between the check and the call */
      }
    } else {
      emitClaimEligible(roomId, (1 - timedOutPlayer) as 0 | 1, m.transcript());
    }
  }

  /** Socket.IO's encoder can't serialize a bigint — send the transcript as JSON-safe strings. */
  function serializeTranscript(t: Transcript) {
    return { ...t, matchId: t.matchId.toString() };
  }

  /** Live blitz clocks for the state payloads (null for untimed matches). */
  function clocksOf(m: Match): [number, number] | null {
    const c0 = m.clockRemainingMs(0);
    const c1 = m.clockRemainingMs(1);
    return c0 === null || c1 === null ? null : [c0, c1];
  }

  function emitClaimEligible(roomId: string, winner: 0 | 1 | 2, transcript: Transcript): void {
    io.to(roomId).emit("claim-eligible", { matchId: roomId, winner, transcript: serializeTranscript(transcript) });
  }

  // Broadcast a just-finished match's state/gameover. Shared by every ending —
  // natural (move-driven), resign, and mutual draw. Casual matches are fully
  // resolved off-chain, so free them from memory immediately; staked matches
  // stay so a claim (or a settleSigned still landing) can read the transcript,
  // and get a short watchdog: if the two-signature fast path hasn't closed the
  // match within UNSETTLED_WATCHDOG_MS, tell the room to self-claim.
  function announceGameOver(matchId: bigint, roomId: string, state: GameState): void {
    clearTurnClock(roomId);
    const gm = hub.get(matchId);
    io.to(roomId).emit("state", { matchId: roomId, state, ply: gm?.ply ?? 0, clocks: gm ? clocksOf(gm) : null });
    io.to(roomId).emit("gameover", { matchId: roomId, winner: state.winner });
    deps.onGameOver?.(matchId, state.winner);

    const players = casualPlayers.get(roomId);
    if (players) {
      casualPlayers.delete(roomId);
      deps.onResult?.(players, state.winner);
    }

    if (isCasualMatch(matchId)) {
      hub.close(matchId);
      return;
    }
    const timer = setTimeout(() => {
      const m = hub.get(matchId); // still present => settleSigned never closed it
      if (m) emitClaimEligible(roomId, state.winner as 0 | 1 | 2, m.transcript());
    }, UNSETTLED_WATCHDOG_MS);
    if ("unref" in timer) timer.unref?.();
  }

  io.on("connection", (socket: Socket) => {
    socket.on(
      "queue",
      async (msg: { address: Address; elo: number; mode?: PlayMode; sessionPubKey?: Address }) => {
        const mode = msg.mode ?? "casual";
        if (deps.personhood) {
          try {
            await assertPersonhood(deps.personhood, msg.address, mode);
          } catch (err) {
            socket.emit("error", { message: (err as Error).message });
            return;
          }
        }
        const pairing = hub.queue({
          id: socket.id,
          address: msg.address,
          elo: msg.elo,
          sessionPubKey: msg.sessionPubKey,
        });
        if (!pairing) return;

        // Casual quick-match: open an off-chain match and tell each player their
        // role so both clients can join and play immediately (no stake/settle).
        if (deps.casualCtx && pairing.a.sessionPubKey && pairing.b.sessionPubKey) {
          const matchId = casualMatchId();
          const startTurn = (Math.random() < 0.5 ? 0 : 1) as 0 | 1;
          hub.open({
            matchId,
            chainId: deps.casualCtx.chainId,
            verifier: deps.casualCtx.verifier,
            sessions: [pairing.a.sessionPubKey, pairing.b.sessionPubKey],
            startTurn,
            clockMs: BLITZ_CLOCK_MS,
          });
          const m = hub.get(matchId)!;
          const id = matchId.toString();
          casualPlayers.set(id, [pairing.a.address, pairing.b.address]); // role 0 = a, role 1 = b
          armTurnClockIfNeeded(matchId, id);
          io.to(pairing.a.id).emit("matched", { matchId: id, role: 0, opponent: pairing.b.address, casual: true });
          io.to(pairing.b.id).emit("matched", { matchId: id, role: 1, opponent: pairing.a.address, casual: true });
          io.to(pairing.a.id).emit("state", { matchId: id, state: m.state, ply: 0, clocks: clocksOf(m) });
          io.to(pairing.b.id).emit("state", { matchId: id, state: m.state, ply: 0, clocks: clocksOf(m) });
          return;
        }

        io.to(pairing.a.id).emit("matched", { opponent: pairing.b.address });
        io.to(pairing.b.id).emit("matched", { opponent: pairing.a.address });
      },
    );

    // subscribe to a match's room and get its current state + ply. Also arms
    // (or catches up) the move-clock — this is how a staked match's clock
    // starts, since it's opened directly by the on-chain listener, not here.
    socket.on("watch", (msg: { matchId: string }) => {
      socket.join(msg.matchId);
      const matchId = BigInt(msg.matchId);
      const m = hub.get(matchId);
      if (m) socket.emit("state", { matchId: msg.matchId, state: m.state, ply: m.ply, clocks: clocksOf(m) });
      armTurnClockIfNeeded(matchId, msg.matchId);
    });

    // A client that reconnects after missing a live "claim-eligible" broadcast
    // (e.g. it discovers on-chain that a result was proposed while it was away)
    // asks for the signed transcript directly so it can decide whether to
    // dispute. Only available while the match is still tracked in memory.
    socket.on("get-transcript", (msg: { matchId: string }) => {
      const t = hub.transcript(BigInt(msg.matchId));
      if (t) socket.emit("transcript", { matchId: msg.matchId, transcript: serializeTranscript(t) });
      else socket.emit("error", { message: "transcript no longer available" });
    });

    socket.on(
      "move",
      async (msg: { matchId: string; player: 0 | 1; house: number; signature: Hex }) => {
        try {
          const matchId = BigInt(msg.matchId);
          const state = await hub.move(matchId, msg.player, msg.house, msg.signature);
          if (state.over) {
            announceGameOver(matchId, msg.matchId, state);
          } else {
            const mm = hub.get(matchId);
            io.to(msg.matchId).emit("state", { matchId: msg.matchId, state, ply: mm?.ply ?? 0, clocks: mm ? clocksOf(mm) : null });
            rearmTurnClock(matchId, msg.matchId);
          }
        } catch (err) {
          socket.emit("error", { message: (err as Error).message });
        }
      },
    );

    // collect a session-key-signed result; settle once both players have signed
    socket.on("result-sig", async (msg: { matchId: string; signature: Hex }) => {
      if (!deps.coordinator) return;
      try {
        const matchId = BigInt(msg.matchId);
        const outcome = await deps.coordinator.submit(hub, matchId, msg.signature);
        if (outcome === "settled") io.to(msg.matchId).emit("settled", { matchId: msg.matchId });
      } catch (err) {
        socket.emit("error", { message: (err as Error).message });
      }
    });

    // concede: opponent wins, no negotiation needed — only the resigner's own
    // signature is required.
    socket.on("resign", async (msg: { matchId: string; player: 0 | 1; signature: Hex }) => {
      try {
        const matchId = BigInt(msg.matchId);
        const state = await hub.resign(matchId, msg.player, msg.signature);
        announceGameOver(matchId, msg.matchId, state);
      } catch (err) {
        socket.emit("error", { message: (err as Error).message });
      }
    });

    // offer a mutual draw — relayed to the opponent, who accepts or ignores it
    socket.on("draw-offer", async (msg: { matchId: string; player: 0 | 1; signature: Hex }) => {
      try {
        const matchId = BigInt(msg.matchId);
        await hub.offerDraw(matchId, msg.player, msg.signature);
        socket.to(msg.matchId).emit("draw-offer", { matchId: msg.matchId, from: msg.player });
      } catch (err) {
        socket.emit("error", { message: (err as Error).message });
      }
    });

    // accept the opponent's pending draw offer — ends the match in a draw
    socket.on("draw-accept", async (msg: { matchId: string; player: 0 | 1; signature: Hex }) => {
      try {
        const matchId = BigInt(msg.matchId);
        const state = await hub.acceptDraw(matchId, msg.player, msg.signature);
        announceGameOver(matchId, msg.matchId, state);
      } catch (err) {
        socket.emit("error", { message: (err as Error).message });
      }
    });

    socket.on("disconnect", () => {
      hub.matchmaker.remove(socket.id);
      // No per-socket cleanup needed beyond this: the move-clock is driven by
      // match state (whose turn, since when), not connection state, so a
      // disconnect on its own does nothing — the clock it's already running
      // against (if it's this player's turn) takes care of it.
    });
  });
}
