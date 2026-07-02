"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { io, type Socket } from "socket.io-client";
import { readContract } from "viem/actions";
import type { Address, Hex } from "viem";
import { getInjectedProvider, connect, publicClient } from "../lib/minipay.js";
import { loadSession, signMove, signResult, signResign, signDrawOffer, type SessionKey } from "../lib/session.js";
import { escrowConfig } from "../lib/escrow.js";
import { matchEscrowAbi } from "../../../protocol/src/abis.js";
import { legalMovesMask, type GameState } from "../../../engine/src/awale.js";
import { Board } from "./Board.js";
import { GameOverlay } from "./GameOverlay.js";
import { PlayerPanel } from "./PlayerPanel.js";
import { computePayout, fmt } from "../lib/money.js";
import { harvestAddress } from "../lib/league.js";
import { recordOpponent } from "../lib/social.js";
import { shareResult } from "../lib/share.js";
import { getEquipped, type EquippedSkin } from "../lib/skins.js";
import { displayName } from "../lib/names.js";
import { Icon } from "./Icon.js";
import { SoundToggle } from "./SoundToggle.js";

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
export function LiveMatch({
  matchId,
  casualRole,
  opponentAddress,
}: {
  matchId: bigint;
  casualRole?: 0 | 1;
  opponentAddress?: Address;
}) {
  const [state, setState] = useState<GameState | null>(null);
  const [ply, setPly] = useState(0);
  const [role, setRole] = useState<0 | 1 | null>(null);
  const [status, setStatus] = useState("Connecting…");
  const [outcome, setOutcome] = useState<0 | 1 | 2 | null>(null); // viewer perspective
  const [settled, setSettled] = useState(false);
  const [skin, setSkin] = useState<EquippedSkin | undefined>(undefined);
  const [oppAddr, setOppAddr] = useState<Address | null>(opponentAddress ?? null);
  const [drawOffered, setDrawOffered] = useState(false); // opponent offered a draw, awaiting our reply
  const [conceding, setConceding] = useState(false);

  useEffect(() => {
    setSkin(getEquipped());
    try {
      localStorage.setItem("awale_played", "1"); // unlocks League/Skins in the nav
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (oppAddr) recordOpponent(oppAddr); // for "recent opponents" / re-challenge
  }, [oppAddr]);

  const session = useRef<SessionKey | null>(null);
  const socket = useRef<Socket | null>(null);
  const ctx = useRef<{ chainId: bigint; verifier: Address } | null>(null);
  const stakeInfo = useRef<{ stake: bigint; rakeBps: number } | null>(null);

  useEffect(() => {
    const cfg = escrowConfig();
    if (!cfg) {
      setStatus("Money matches aren’t available on this deployment");
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
        setOppAddr(r === 0 ? m.player1 : m.player0);
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
        setStatus((s) => `${s} · winnings paid out ✅`);
      });
      sock.on("draw-offer", (msg: { from: 0 | 1 }) => {
        if (msg.from !== myRole) setDrawOffered(true);
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

  // A stuck or hopeless game shouldn't trap the money: either player can
  // concede outright (opponent wins), or both can agree to split it as a draw.
  async function resign() {
    if (!state || state.over || role === null || !session.current || !ctx.current || conceding) return;
    setConceding(true);
    try {
      const sig = await signResign(session.current, matchId, BigInt(ply), ctx.current);
      socket.current?.emit("resign", { matchId: matchId.toString(), player: role, signature: sig as Hex });
    } finally {
      setConceding(false);
    }
  }

  async function offerDraw() {
    if (!state || state.over || role === null || !session.current || !ctx.current || conceding) return;
    setConceding(true);
    try {
      const sig = await signDrawOffer(session.current, matchId, BigInt(ply), ctx.current);
      socket.current?.emit("draw-offer", { matchId: matchId.toString(), player: role, signature: sig as Hex });
      setStatus((s) => `${s} · draw offered, waiting on opponent`);
    } finally {
      setConceding(false);
    }
  }

  async function replyToDraw(accept: boolean) {
    setDrawOffered(false);
    if (!accept || !state || state.over || role === null || !session.current || !ctx.current) return;
    const sig = await signDrawOffer(session.current, matchId, BigInt(ply), ctx.current);
    socket.current?.emit("draw-accept", { matchId: matchId.toString(), player: role, signature: sig as Hex });
  }

  const myTurn = state !== null && role !== null && !state.over && state.turn === role;
  const playable = myTurn ? legalHouses(state) : [];

  const myScore = role === 1 ? state?.store1 : state?.store0;
  const oppScore = role === 1 ? state?.store0 : state?.store1;

  return (
    <main className="stack" style={{ flex: 1, gap: 14, position: "relative", padding: "12px 8px" }}>
      <div className="row" style={{ padding: "0 6px" }}>
        <Link className="btn ghost" href="/" style={{ padding: "6px 10px" }}>
          <Icon name="back" size={16} /> Back
        </Link>
        <span className="row" style={{ gap: 8 }}>
          {state && !state.over && (
            <>
              <button className="btn ghost" style={{ padding: "6px 10px", fontSize: 12.5 }} onClick={offerDraw} disabled={conceding}>
                Offer draw
              </button>
              <button className="btn ghost" style={{ padding: "6px 10px", fontSize: 12.5 }} onClick={resign} disabled={conceding}>
                Resign
              </button>
            </>
          )}
          {settled && (
            <span className="chip positive">
              <span className="dot" />
              settled
            </span>
          )}
          <span className="chip">match #{matchId.toString()}</span>
          <SoundToggle />
        </span>
      </div>

      {drawOffered && (
        <div className="card row animate-in" style={{ gap: 10, alignItems: "center", justifyContent: "space-between" }}>
          <span className="muted">Your opponent offers a draw</span>
          <span className="row" style={{ gap: 6 }}>
            <button className="btn secondary" style={{ padding: "6px 12px" }} onClick={() => replyToDraw(false)}>
              Decline
            </button>
            <button className="btn" style={{ padding: "6px 12px" }} onClick={() => replyToDraw(true)}>
              Accept
            </button>
          </span>
        </div>
      )}

      {state ? (
        <div className="stack" style={{ gap: 14, marginTop: 4 }}>
          <PlayerPanel
            name={displayName(oppAddr)}
            score={oppScore ?? 0}
            active={!state.over && role !== null && state.turn !== role}
          />
          <Board state={state} perspective={role ?? 0} onPlay={play} playable={playable} skin={skin} />
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
          stats={{ mine: myScore ?? 0, opp: oppScore ?? 0, moves: ply }}
          payout={
            outcome === 0 && stakeInfo.current
              ? `${fmt(computePayout(stakeInfo.current.stake, stakeInfo.current.rakeBps).prize, STAKE_DECIMALS)} ${STAKE_SYMBOL}`
              : undefined
          }
          saveHref={
            outcome === 0 && stakeInfo.current && harvestAddress()
              ? `/league?deposit=${Math.max(
                  1,
                  Math.round(Number(fmt(computePayout(stakeInfo.current.stake, stakeInfo.current.rakeBps).prize, STAKE_DECIMALS)) * 0.3),
                )}`
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
