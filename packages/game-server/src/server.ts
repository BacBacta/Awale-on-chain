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
//   "resign"      { matchId, player, signature }           concede; opponent wins
//   "draw-offer"  { matchId, player, signature }            offer a mutual draw
//   "draw-accept" { matchId, player, signature }            accept the pending draw offer
// Server -> client:
//   "matched"    { opponent }
//   "state"      { matchId, state, ply }
//   "gameover"   { matchId, winner }
//   "settled"    { matchId }
//   "draw-offer" { matchId, from }                          relayed to the opponent
//   "error"      { message }

import type { Server, Socket } from "socket.io";
import type { Address, Hex } from "viem";
import { GameHub } from "./hub.js";
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

    // Broadcast a just-finished match's state/gameover and arm the settlement
    // fallback. Shared by the natural (move-driven) ending and the early-exit
    // paths (resign, mutual draw) below — they all end up here.
    function announceGameOver(matchId: bigint, roomId: string, state: GameState): void {
      io.to(roomId).emit("state", { matchId: roomId, state, ply: hub.get(matchId)?.ply ?? 0 });
      io.to(roomId).emit("gameover", { matchId: roomId, winner: state.winner });
      deps.coordinator?.armProposalFallback(hub, matchId, state.winner);
      deps.onGameOver?.(matchId, state.winner);
    }

    socket.on(
      "move",
      async (msg: { matchId: string; player: 0 | 1; house: number; signature: Hex }) => {
        try {
          const matchId = BigInt(msg.matchId);
          const state = await hub.move(matchId, msg.player, msg.house, msg.signature);
          if (state.over) {
            announceGameOver(matchId, msg.matchId, state);
          } else {
            io.to(msg.matchId).emit("state", { matchId: msg.matchId, state, ply: hub.get(matchId)?.ply ?? 0 });
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
    });
  });
}
