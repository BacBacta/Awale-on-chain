// Socket.IO transport (integration layer).
//
// Thin wiring from socket events to the GameHub. All authoritative logic lives
// in the hub/Match/engine; this file only translates messages.
//
// Protocol (client -> server):
//   "queue"      { address, elo, mode? }                    join matchmaking ("casual"
//                                                            by default; "ranked"/"cash"
//                                                            require personhood verification)
//   "watch"      { matchId }                               subscribe to a match room
//   "move"       { matchId, player, house, signature }     a session-key-signed move
//   "result-sig" { matchId, signature }                    a session-key-signed result
// Server -> client:
//   "matched"  { opponent }
//   "state"    { matchId, state, ply }
//   "gameover" { matchId, winner }
//   "settled"  { matchId }
//   "error"    { message }

import type { Server, Socket } from "socket.io";
import type { Address, Hex } from "viem";
import { GameHub } from "./hub.js";
import type { SettlementCoordinator } from "./settlement-coordinator.js";
import { assertPersonhood } from "./personhood/gate.js";
import type { PersonhoodRegistry, PlayMode } from "./personhood/types.js";

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
}

/** A fresh, collision-free id for an off-chain casual match. */
function casualMatchId(): bigint {
  return (1n << 200n) + BigInt(Math.floor(Math.random() * 1e15)) * 1000n + BigInt(Math.floor(Math.random() * 1000));
}

export function attachSocketIO(io: Server, deps: ServerDeps): void {
  const { hub } = deps;

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
          });
          const m = hub.get(matchId)!;
          const id = matchId.toString();
          io.to(pairing.a.id).emit("matched", { matchId: id, role: 0, opponent: pairing.b.address, casual: true });
          io.to(pairing.b.id).emit("matched", { matchId: id, role: 1, opponent: pairing.a.address, casual: true });
          io.to(pairing.a.id).emit("state", { matchId: id, state: m.state, ply: 0 });
          io.to(pairing.b.id).emit("state", { matchId: id, state: m.state, ply: 0 });
          return;
        }

        io.to(pairing.a.id).emit("matched", { opponent: pairing.b.address });
        io.to(pairing.b.id).emit("matched", { opponent: pairing.a.address });
      },
    );

    // subscribe to a match's room and get its current state + ply
    socket.on("watch", (msg: { matchId: string }) => {
      socket.join(msg.matchId);
      const m = hub.get(BigInt(msg.matchId));
      if (m) socket.emit("state", { matchId: msg.matchId, state: m.state, ply: m.ply });
    });

    socket.on(
      "move",
      async (msg: { matchId: string; player: 0 | 1; house: number; signature: Hex }) => {
        try {
          const matchId = BigInt(msg.matchId);
          const state = await hub.move(matchId, msg.player, msg.house, msg.signature);
          const ply = hub.get(matchId)?.ply ?? 0;
          io.to(msg.matchId).emit("state", { matchId: msg.matchId, state, ply });
          if (state.over) {
            io.to(msg.matchId).emit("gameover", { matchId: msg.matchId, winner: state.winner });
            // Arm the abandonment fallback: if a player never signs the result,
            // the server proposes it on-chain so the winner can still be paid.
            deps.coordinator?.armProposalFallback(hub, matchId, state.winner);
            deps.onGameOver?.(matchId, state.winner);
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

    socket.on("disconnect", () => {
      hub.matchmaker.remove(socket.id);
    });
  });
}
