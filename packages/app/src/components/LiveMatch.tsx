"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { io, type Socket } from "socket.io-client";
import { readContract } from "viem/actions";
import type { Address, Hex } from "viem";
import { getInjectedProvider, connect, publicClient } from "../lib/minipay.js";
import { loadSession, signMove, signResult, signResign, signDrawOffer, type SessionKey } from "../lib/session.js";
import { escrowConfig, proposeResult, challengeResult, type WriteClient } from "../lib/escrow.js";
import { stakeTokens } from "../lib/stakeTokens.js";
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

interface WireTranscript {
  matchId: string;
  session0: Address;
  session1: Address;
  startTurn: 0 | 1;
  moves: number[];
  sigs: Hex[];
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
  // Blitz clocks as last reported by the server, plus when we heard them — the
  // active player's display ticks down locally between server updates.
  const [clocks, setClocks] = useState<[number, number] | null>(null);
  const [clocksAt, setClocksAt] = useState(0);
  const [, setTick] = useState(0); // re-render pulse for the countdown
  // A staked match's move-clock ran out (or a natural ending never settled)
  // and *someone* is eligible to claim on-chain. `theirClaim` is set only
  // when the opponent is the one claiming, so we can offer to dispute it.
  const [theirClaim, setTheirClaim] = useState<{ winner: 0 | 1 | 2; transcript: WireTranscript } | null>(null);
  const [claimStatus, setClaimStatus] = useState<string | null>(null);

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
  const wallet = useRef<WriteClient | null>(null);
  const myAddress = useRef<Address | null>(null);
  const feeCurrency = useRef<Address | undefined>(undefined);
  const roleRef = useRef<0 | 1 | null>(null);

  useEffect(() => {
    const cfg = escrowConfig();
    if (!cfg) {
      setStatus("Money matches aren’t available on this deployment");
      return;
    }
    let sock: Socket | null = null;

    (async () => {
      let myRole: 0 | 1;
      let needsClaimCatchUp = false; // a result was proposed while we were away
      if (casualRole != null) {
        myRole = casualRole; // role known from matchmaking; no on-chain match exists
      } else {
        const provider = getInjectedProvider();
        if (!provider) {
          setStatus("Open in MiniPay to play");
          return;
        }
        const { wallet: w, address } = await connect(provider, cfg.chainId);
        wallet.current = w as unknown as WriteClient;
        myAddress.current = address;
        const client = publicClient(cfg.rpcUrl, cfg.chainId);
        const m = (await readContract(client, {
          address: cfg.escrow,
          abi: matchEscrowAbi,
          functionName: "getMatch",
          args: [matchId],
        })) as { token: Address; player0: Address; player1: Address; stake: bigint; rakeBps: number; status: number; proposedWinner: number };
        stakeInfo.current = { stake: m.stake, rakeBps: Number(m.rakeBps) };
        feeCurrency.current = stakeTokens().find((t) => t.address.toLowerCase() === m.token.toLowerCase())?.feeCurrency;
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

        // A claim may already exist from while we were away (missed the live
        // "claim-eligible" broadcast entirely). status 3 = Proposed. Only
        // chase it down if it's *not* our own claim.
        needsClaimCatchUp = m.status === 3 && m.proposedWinner !== r;
      }
      const sk = loadSession(matchId);
      if (!sk) {
        setStatus("Session key not found — create/join from this device");
        return;
      }
      setRole(myRole);
      roleRef.current = myRole;
      session.current = sk;
      ctx.current = { chainId: BigInt(cfg.chainId), verifier: cfg.verifier };

      sock = io(SERVER_URL, { transports: ["websocket"] });
      socket.current = sock;
      sock.on("connect", () => {
        sock!.emit("watch", { matchId: matchId.toString() });
        if (needsClaimCatchUp) sock!.emit("get-transcript", { matchId: matchId.toString() });
        setStatus("Connected");
      });
      sock.on("state", (msg: { state: GameState; ply: number; clocks?: [number, number] | null }) => {
        setState(msg.state);
        setPly(msg.ply);
        if (msg.clocks !== undefined) {
          setClocks(msg.clocks);
          setClocksAt(Date.now());
        }
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
      // A staked match's move-clock ran out, or a natural ending never
      // settled via the two-signature fast path. Whoever the payload names as
      // `winner` should self-claim; if it's the *other* player, offer to
      // dispute instead of silently losing to a claim that may be wrong.
      sock.on("claim-eligible", (msg: { winner: 0 | 1 | 2; transcript: WireTranscript }) => {
        if (casualRole != null) return; // no on-chain settlement for casual play
        if (msg.winner === roleRef.current) void selfClaim(msg.winner, msg.transcript);
        else setTheirClaim({ winner: msg.winner, transcript: msg.transcript });
      });
      // Reply to our own catch-up "get-transcript" request (a claim existed
      // from before we reconnected) — same handling as a live claim-eligible.
      sock.on("transcript", (msg: { transcript: WireTranscript }) => {
        if (casualRole != null || roleRef.current === null) return;
        setTheirClaim({ winner: roleRef.current === 0 ? 1 : 0, transcript: msg.transcript });
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

  // The opponent's move-clock ran out (or a finished game never got both
  // signatures) and *we* are the declared winner — settle it on-chain
  // ourselves rather than waiting on a server that was never allowed to do
  // this on our behalf. No user action needed; it just happens.
  async function selfClaim(winner: 0 | 1 | 2, transcript: WireTranscript) {
    const cfg = escrowConfig();
    if (!cfg || !wallet.current || !myAddress.current) return;
    setClaimStatus("Opponent ran out of time — settling on-chain…");
    try {
      await proposeResult(wallet.current, {
        account: myAddress.current,
        escrow: cfg.escrow,
        matchId,
        winner,
        startTurn: transcript.startTurn,
        moves: transcript.moves,
        feeCurrency: feeCurrency.current,
      });
      setClaimStatus("Claim submitted — payout in ~10 min unless disputed.");
    } catch (e) {
      setClaimStatus(`Claim failed: ${(e as Error).message}`);
    }
  }

  // The opponent claimed a result we don't believe is right (we're still
  // here, or we came back to find it). Replay the real signed transcript
  // on-chain: pays the true winner if the game had actually finished, voids
  // (refunds both) otherwise — the claim can never just take the pot.
  async function dispute() {
    const cfg = escrowConfig();
    if (!cfg || !wallet.current || !myAddress.current || !theirClaim) return;
    setClaimStatus("Disputing with the real transcript…");
    try {
      await challengeResult(wallet.current, {
        account: myAddress.current,
        escrow: cfg.escrow,
        matchId,
        session0: theirClaim.transcript.session0,
        session1: theirClaim.transcript.session1,
        startTurn: theirClaim.transcript.startTurn,
        moves: theirClaim.transcript.moves,
        sigs: theirClaim.transcript.sigs,
        feeCurrency: feeCurrency.current,
      });
      setClaimStatus("Dispute submitted.");
      setTheirClaim(null);
    } catch (e) {
      setClaimStatus(`Dispute failed: ${(e as Error).message}`);
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

  // Tick the countdown display twice a second while a timed game is live.
  useEffect(() => {
    if (!clocks || !state || state.over) return;
    const iv = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(iv);
  }, [clocks !== null, state?.over]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Live remaining time for a seat: the server's snapshot, minus local elapsed
   *  time if that seat is currently on the move. */
  function liveClock(player: 0 | 1): number | null {
    if (!clocks || !state) return null;
    const base = clocks[player];
    if (state.over || state.turn !== player) return base;
    return Math.max(0, base - (Date.now() - clocksAt));
  }

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

      {theirClaim && (
        <div className="card stack animate-in" style={{ gap: 8 }}>
          <span className="muted">
            Your opponent claimed {theirClaim.winner === 2 ? "a draw" : theirClaim.winner === role ? "you as the winner" : "victory"} on-chain.
            If that's not right, dispute it with the real game — it can't take the pot on a false claim.
          </span>
          <button className="btn block" onClick={dispute}>
            Dispute
          </button>
        </div>
      )}

      {claimStatus && (
        <div className="row" style={{ justifyContent: "center" }}>
          <span className="chip">
            <span className="dot pulse" />
            {claimStatus}
          </span>
        </div>
      )}

      {state ? (
        <div className="stack" style={{ gap: 14, marginTop: 4 }}>
          <PlayerPanel
            name={displayName(oppAddr)}
            score={oppScore ?? 0}
            active={!state.over && role !== null && state.turn !== role}
            clockMs={role !== null ? liveClock((1 - role) as 0 | 1) : null}
          />
          <Board state={state} perspective={role ?? 0} onPlay={play} playable={playable} skin={skin} />
          <PlayerPanel name="You" you score={myScore ?? 0} active={myTurn} clockMs={role !== null ? liveClock(role) : null} />
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
