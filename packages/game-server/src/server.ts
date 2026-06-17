// Socket.IO transport (integration layer).
//
// Thin wiring from socket events to the GameHub. All authoritative logic lives
// in the hub/Match/engine; this file only translates messages. It is exercised
// in integration tests, not unit tests.
//
// Protocol (client -> server):
//   "queue"  { address, elo }                      join ranked matchmaking
//   "move"   { matchId, player, house, signature } submit a session-key-signed move
// Server -> client:
//   "matched"  { matchId, opponent }
//   "state"    { matchId, state }
//   "gameover" { matchId, winner }
//   "error"    { message }

import type { Server, Socket } from "socket.io";
import type { Address } from "viem";
import { GameHub } from "./hub.js";

export interface ServerDeps {
  hub: GameHub;
  /** Called when a game ends so the app can drive on-chain settlement. */
  onGameOver?: (matchId: bigint, winner: number) => void;
}

export function attachSocketIO(io: Server, deps: ServerDeps): void {
  const { hub } = deps;

  io.on("connection", (socket: Socket) => {
    socket.on("queue", (msg: { address: Address; elo: number }) => {
      const pairing = hub.queue({ id: socket.id, address: msg.address, elo: msg.elo });
      if (pairing) {
        // a real deployment now waits for both players to joinMatch on-chain,
        // reads the session keys + startTurn from the join events, then opens
        // the match in the hub and notifies both sockets.
        io.to(pairing.a.id).emit("matched", { opponent: pairing.b.address });
        io.to(pairing.b.id).emit("matched", { opponent: pairing.a.address });
      }
    });

    socket.on(
      "move",
      async (msg: { matchId: string; player: 0 | 1; house: number; signature: `0x${string}` }) => {
        try {
          const matchId = BigInt(msg.matchId);
          const state = await hub.move(matchId, msg.player, msg.house, msg.signature);
          io.to(msg.matchId).emit("state", { matchId: msg.matchId, state });
          if (state.over) {
            io.to(msg.matchId).emit("gameover", { matchId: msg.matchId, winner: state.winner });
            deps.onGameOver?.(matchId, state.winner);
          }
        } catch (err) {
          socket.emit("error", { message: (err as Error).message });
        }
      },
    );

    socket.on("disconnect", () => {
      hub.matchmaker.remove(socket.id);
    });
  });
}
