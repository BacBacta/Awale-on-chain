// Socket.IO transport (integration layer).
//
// Thin wiring from socket events to the GameHub. All authoritative logic lives
// in the hub/Match/engine; this file only translates messages.
//
// Protocol (client -> server):
//   "queue"      { address, elo }                          join ranked matchmaking
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

export interface ServerDeps {
  hub: GameHub;
  /** Collects result signatures and submits settleSigned (optional). */
  coordinator?: SettlementCoordinator;
  /** Called when a game ends so the app can react. */
  onGameOver?: (matchId: bigint, winner: number) => void;
}

export function attachSocketIO(io: Server, deps: ServerDeps): void {
  const { hub } = deps;

  io.on("connection", (socket: Socket) => {
    socket.on("queue", (msg: { address: Address; elo: number }) => {
      const pairing = hub.queue({ id: socket.id, address: msg.address, elo: msg.elo });
      if (pairing) {
        io.to(pairing.a.id).emit("matched", { opponent: pairing.b.address });
        io.to(pairing.b.id).emit("matched", { opponent: pairing.a.address });
      }
    });

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
