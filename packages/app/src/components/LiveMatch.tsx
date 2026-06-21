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
import { GameOverlay } from "./GameOverlay.js";
import { PlayerPanel } from "./PlayerPanel.js";
import { computePayout, fmt } from "../lib/money.js";
import { shareResult } from "../lib/share.js";

const STAKE_DECIMALS = Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "6");
const STAKE_SYMBOL = process.env.NEXT_PUBLIC_STAKE_SYMBOL ?? "USDC";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

function legalHouses(s: GameState): number[] {
  const mask = legalMovesMask(s);
  const out: number[] = [];
  for (let h = 0; h < 6; h++) if (mask & (1 << h)) out.push(h);
  return out;
}

/** A real match played over the game server: live board, session-key-signed moves.
 *  `casualRole` (from Quick Match) plays an off-chain casual match — role is known
 *  from matchmaking, so it skips the on-chain match read and the settlement step. */
export function LiveMatch({ matchId, casualRole }: { matchId: bigint; casualRole?: 0 | 1 }) {
  const [state, setState] = useState<GameState | null>(null);
  const [ply, setPly] = useState(0);
  const [role, setRole] = useState<0 | 1 | null>(null);
  const [status, setStatus] = useState("Connecting…");
  const [outcome, setOutcome] = useState<0 | 1 | 2 | null>(null); // viewer perspective
  const [settled, setSettled] = useState(false);

  const session = useRef<SessionKey | null>(null);
  const socket = useRef<Socket | null>(null);
  const ctx = useRef<{ chainId: bigint; verifier: Address } | null>(null);
  const stakeInfo = useRef<{ stake: bigint; rakeBps: number } | null>(null);

  useEffect(() => {
    const cfg = escrowConfig();
    if (!cfg) {
      setStatus("App not configured for on-chain play");
      return;
    }
    let sock: Socket | null = null;

    (async () => {
      let myRole: 0 | 1;
      if (casualRole != null) {
        myRole = casualRole; // role known from matchmaking; no on-chain match exists
      } else {
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
        })) as { player0: Address; player1: Address; stake: bigint; rakeBps: number };
        stakeInfo.current = { stake: m.stake, rakeBps: Number(m.rakeBps) };
        const r =
          address.toLowerCase() === m.player0.toLowerCase()
            ? 0
            : address.toLowerCase() === m.player1.toLowerCase()
              ? 1
              : null;
        if (r === null) {
          setStatus("This wallet is not a player in this match");
          return;
        }
        myRole = r;
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
        setOutcome(msg.winner === myRole ? 0 : msg.winner === 2 ? 2 : 1);
        if (casualRole == null && session.current && ctx.current) {
          const sig = await signResult(session.current, matchId, msg.winner, {
            chainId: ctx.current.chainId,
            escrow: cfg.escrow,
          });
          sock!.emit("result-sig", { matchId: matchId.toString(), signature: sig });
        }
      });
      sock.on("settled", () => {
        setSettled(true);
        setStatus((s) => `${s} · settled on-chain ✅`);
      });
      sock.on("error", (e: { message: string }) => setStatus(e.message));
    })().catch((e) => setStatus((e as Error).message));

    return () => {
      sock?.close();
    };
  }, [matchId, casualRole]);

  async function play(house: number) {
    if (!state || state.over || role === null || state.turn !== role) return;
    if (!session.current || !ctx.current) return;
    const sig = await signMove(session.current, matchId, BigInt(ply), house, ctx.current);
    socket.current?.emit("move", { matchId: matchId.toString(), player: role, house, signature: sig as Hex });
  }

  const myTurn = state !== null && role !== null && !state.over && state.turn === role;
  const playable = myTurn ? legalHouses(state) : [];

  const myScore = role === 1 ? state?.store1 : state?.store0;
  const oppScore = role === 1 ? state?.store0 : state?.store1;

  return (
    <main className="pad stack" style={{ flex: 1, gap: 16, position: "relative" }}>
      <div className="row">
        <Link className="btn ghost" href="/" style={{ padding: "6px 10px" }}>
          ← Back
        </Link>
        <span className="row" style={{ gap: 8 }}>
          {settled && (
            <span className="chip positive">
              <span className="dot" />
              settled
            </span>
          )}
          <span className="chip">match #{matchId.toString()}</span>
        </span>
      </div>

      {state ? (
        <div className="stack" style={{ flex: 1, justifyContent: "center", gap: 12 }}>
          <PlayerPanel
            name="Opponent"
            score={oppScore ?? 0}
            active={!state.over && role !== null && state.turn !== role}
          />
          <Board state={state} perspective={role ?? 0} onPlay={play} playable={playable} />
          <PlayerPanel name="You" you score={myScore ?? 0} active={myTurn} />
          {state.over && (
            <div className="row" style={{ justifyContent: "center" }}>
              <span className="chip">
                <span className="dot" />
                {status}
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <span className="chip">
            <span className="dot pulse" />
            {status}
          </span>
        </div>
      )}

      {outcome !== null && state?.over && (
        <GameOverlay
          result={outcome}
          payout={
            outcome === 0 && stakeInfo.current
              ? `${fmt(computePayout(stakeInfo.current.stake, stakeInfo.current.rakeBps).prize, STAKE_DECIMALS)} ${STAKE_SYMBOL}`
              : undefined
          }
          onPlayAgain={() => (window.location.href = "/")}
          onShare={() =>
            shareResult({
              result: outcome,
              scoreMine: myScore ?? 0,
              scoreOpp: oppScore ?? 0,
              payout:
                outcome === 0 && stakeInfo.current
                  ? `${fmt(computePayout(stakeInfo.current.stake, stakeInfo.current.rakeBps).prize, STAKE_DECIMALS)} ${STAKE_SYMBOL}`
                  : undefined,
            })
          }
        />
      )}
    </main>
  );
}
