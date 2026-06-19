"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { io, type Socket } from "socket.io-client";
import { readContract } from "viem/actions";
import type { Address, Hex } from "viem";
import { getInjectedProvider, connect, publicClient } from "../lib/minipay.js";
import { loadSession, signMove, signResult, type SessionKey } from "../lib/session.js";
import { escrowConfig } from "../lib/escrow.js";
import { matchEscrowAbi } from "../../../protocol/src/abis.js";
import { legalMovesMask, type GameState } from "../../../engine/src/awale.js";
import { Board } from "./Board.js";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

function legalHouses(s: GameState): number[] {
  const mask = legalMovesMask(s);
  const out: number[] = [];
  for (let h = 0; h < 6; h++) if (mask & (1 << h)) out.push(h);
  return out;
}

/** A real match played over the game server: live board, session-key-signed moves. */
export function LiveMatch({ matchId }: { matchId: bigint }) {
  const [state, setState] = useState<GameState | null>(null);
  const [ply, setPly] = useState(0);
  const [role, setRole] = useState<0 | 1 | null>(null);
  const [status, setStatus] = useState("Connecting…");

  const session = useRef<SessionKey | null>(null);
  const socket = useRef<Socket | null>(null);
  const ctx = useRef<{ chainId: bigint; verifier: Address } | null>(null);

  useEffect(() => {
    const cfg = escrowConfig();
    if (!cfg) {
      setStatus("App not configured for on-chain play");
      return;
    }
    let sock: Socket | null = null;

    (async () => {
      const provider = getInjectedProvider();
      if (!provider) {
        setStatus("Open in MiniPay to play");
        return;
      }
      const { address } = await connect(provider, cfg.chainId);
      const client = publicClient(cfg.rpcUrl, cfg.chainId);
      const m = (await readContract(client, {
        address: cfg.escrow,
        abi: matchEscrowAbi,
        functionName: "getMatch",
        args: [matchId],
      })) as { player0: Address; player1: Address };

      const myRole =
        address.toLowerCase() === m.player0.toLowerCase()
          ? 0
          : address.toLowerCase() === m.player1.toLowerCase()
            ? 1
            : null;
      if (myRole === null) {
        setStatus("This wallet is not a player in this match");
        return;
      }
      const sk = loadSession(matchId);
      if (!sk) {
        setStatus("Session key not found — create/join from this device");
        return;
      }
      setRole(myRole);
      session.current = sk;
      ctx.current = { chainId: BigInt(cfg.chainId), verifier: cfg.verifier };

      sock = io(SERVER_URL, { transports: ["websocket"] });
      socket.current = sock;
      sock.on("connect", () => {
        sock!.emit("watch", { matchId: matchId.toString() });
        setStatus("Connected");
      });
      sock.on("state", (msg: { state: GameState; ply: number }) => {
        setState(msg.state);
        setPly(msg.ply);
      });
      sock.on("gameover", async (msg: { winner: number }) => {
        setStatus(msg.winner === myRole ? "You win 🎉" : msg.winner === 2 ? "Draw" : "You lose");
        if (session.current && ctx.current) {
          const sig = await signResult(session.current, matchId, msg.winner, {
            chainId: ctx.current.chainId,
            escrow: cfg.escrow,
          });
          sock!.emit("result-sig", { matchId: matchId.toString(), signature: sig });
        }
      });
      sock.on("settled", () => setStatus((s) => `${s} · settled on-chain ✅`));
      sock.on("error", (e: { message: string }) => setStatus(e.message));
    })().catch((e) => setStatus((e as Error).message));

    return () => {
      sock?.close();
    };
  }, [matchId]);

  async function play(house: number) {
    if (!state || state.over || role === null || state.turn !== role) return;
    if (!session.current || !ctx.current) return;
    const sig = await signMove(session.current, matchId, BigInt(ply), house, ctx.current);
    socket.current?.emit("move", { matchId: matchId.toString(), player: role, house, signature: sig as Hex });
  }

  const myTurn = state !== null && role !== null && !state.over && state.turn === role;
  const playable = myTurn ? legalHouses(state) : [];

  return (
    <main className="pad" style={{ display: "flex", flexDirection: "column", gap: 16, flex: 1 }}>
      <div className="row">
        <Link className="muted" href="/">
          ← Back
        </Link>
        <span className="muted">match #{matchId.toString()}</span>
      </div>

      {state ? (
        <>
          <Board state={state} perspective={role ?? 0} onPlay={play} playable={playable} />
          <div className="card row">
            <span className="muted">{state.over ? status : myTurn ? "Your turn" : "Opponent…"}</span>
            <span className="title">
              {role === 1 ? state.store1 : state.store0} – {role === 1 ? state.store0 : state.store1}
            </span>
          </div>
        </>
      ) : (
        <div className="card muted">{status}</div>
      )}
    </main>
  );
}
