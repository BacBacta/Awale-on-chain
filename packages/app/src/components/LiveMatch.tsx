"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { io, type Socket } from "socket.io-client";
import { readContract } from "viem/actions";
import type { Address, Hex } from "viem";
import { getInjectedProvider, connect, publicClient } from "../lib/minipay.js";
import { loadSession, createSessionKey, persistSession, signMove, signResult, signResign, signDrawOffer, type SessionKey } from "../lib/session.js";
import { escrowConfig, proposeResult, challengeResult, cancelMatch, approve, joinMatch, type WriteClient } from "../lib/escrow.js";
import { humanizeError } from "../lib/errors.js";
import { stakeTokens } from "../lib/stakeTokens.js";
import { recordLocalMatch } from "../lib/matches.js";
import { track } from "../lib/analytics.js";
import { matchEscrowAbi, erc20Abi } from "../../../protocol/src/abis.js";
import { legalMovesMask, type GameState } from "../../../engine/src/awale.js";
import { Board } from "./Board.js";
import { GameOverlay } from "./GameOverlay.js";
import { PlayerPanel } from "./PlayerPanel.js";
import { computePayout, fmt } from "../lib/money.js";
import { recordOpponent } from "../lib/social.js";
import { shareResult } from "../lib/share.js";
import { getEquipped, type EquippedSkin } from "../lib/skins.js";
import { displayName } from "../lib/names.js";
import { Icon } from "./Icon.js";
import { SoundToggle } from "./SoundToggle.js";
import { CrossMatchOffer } from "./CrossMatchOffer.js";

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
  // On-chain status 1 = Open: created but nobody has joined yet. Without this
  // the match screen is a blank "Connected" — say so, and hand out the invite.
  const [waitingOpen, setWaitingOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // A visitor who followed the invite link to an Open match isn't a player
  // YET — the link's whole point is that they can become one right here.
  // (This screen used to just say "not a player", a dead end for every guest.)
  const [joinOffer, setJoinOffer] = useState<{ token: Address; stake: bigint; rakeBps: number } | null>(null);
  const [joiningNow, setJoiningNow] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  // Mobile data blinks constantly for this audience — say so the moment it
  // happens (the server grants the mover one reconnection grace, but the
  // player must see WHY the board went quiet or they'll assume the app died).
  const [connLost, setConnLost] = useState(false);
  // A staked match's move-clock ran out (or a natural ending never settled)
  // and *someone* is eligible to claim on-chain. `theirClaim` is set ONLY for
  // a claim that actually exists on-chain (the transcript catch-up path) —
  // that's when "dispute" is real. The mere eligibility broadcast sets
  // `timedOut` instead: telling a player "your opponent claimed victory
  // on-chain" before anything was on-chain (with a Dispute button that had
  // nothing to dispute) was a lie the tests caught.
  const [theirClaim, setTheirClaim] = useState<{ winner: 0 | 1 | 2; transcript: WireTranscript } | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [claimStatus, setClaimStatus] = useState<string | null>(null);
  // Once a claim is in flight (ours or theirs) or a flag fell, watch the
  // chain until the money actually moves — then close the loop with a real
  // game-over instead of leaving the loser staring at a frozen board forever
  // and paying the winner in silence.
  const [settleWatch, setSettleWatch] = useState(false);
  const [chainEnded, setChainEnded] = useState<"won" | "lost" | "refunded" | null>(null);

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
        // interactive: reaching a money match IS user intent (created it, or
        // followed an invite link) — desktop wallets prompt for access here;
        // MiniPay connects silently as always
        const { wallet: w, address } = await connect(provider, cfg.chainId, { interactive: true });
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
          if (Number(m.status) === 1) {
            // Open match, visitor isn't the creator: this is an invitee —
            // offer the seat instead of a dead end
            setJoinOffer({ token: m.token, stake: m.stake, rakeBps: Number(m.rakeBps) });
          } else {
            setStatus("This match already has two players.");
          }
          return;
        }
        myRole = r;
        setOppAddr(r === 0 ? m.player1 : m.player0);

        // A claim may already exist from while we were away (missed the live
        // "claim-eligible" broadcast entirely). status 3 = Proposed. Only
        // chase it down if it's *not* our own claim.
        needsClaimCatchUp = m.status === 3 && m.proposedWinner !== r;
        setWaitingOpen(m.status === 1); // Open: still waiting for an opponent
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
        // declaring our seat lets the server grant this player their
        // one-per-game reconnection grace if the link drops mid-move
        sock!.emit("watch", { matchId: matchId.toString(), player: myRole });
        if (needsClaimCatchUp) sock!.emit("get-transcript", { matchId: matchId.toString() });
        setStatus("Connected");
        setConnLost(false);
      });
      sock.on("disconnect", () => setConnLost(true));
      sock.io.on("reconnect", () => setConnLost(false));
      sock.on("state", (msg: { state: GameState; ply: number; clocks?: [number, number] | null }) => {
        setState(msg.state);
        setPly(msg.ply);
        setTimedOut(false); // the game moved on — the eligibility notice is stale
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
        else setTimedOut(true); // eligibility only — nothing on-chain to dispute yet
      });
      // Reply to our own catch-up "get-transcript" request (a claim existed
      // from before we reconnected) — same handling as a live claim-eligible.
      sock.on("transcript", (msg: { transcript: WireTranscript }) => {
        if (casualRole != null || roleRef.current === null) return;
        setTheirClaim({ winner: roleRef.current === 0 ? 1 : 0, transcript: msg.transcript });
      });
      sock.on("error", (e: { message: string }) => setStatus(e.message));
    })().catch((e) => setStatus(humanizeError(e)));

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
      setSettleWatch(true);
    } catch (e) {
      setClaimStatus(`Claim failed: ${humanizeError(e)}`);
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
      setSettleWatch(true);
    } catch (e) {
      setClaimStatus(`Dispute failed: ${humanizeError(e)}`);
    }
  }

  async function replyToDraw(accept: boolean) {
    setDrawOffered(false);
    if (!accept || !state || state.over || role === null || !session.current || !ctx.current) return;
    const sig = await signDrawOffer(session.current, matchId, BigInt(ply), ctx.current);
    socket.current?.emit("draw-accept", { matchId: matchId.toString(), player: role, signature: sig as Hex });
  }

  // The hub only opens a staked match once the opponent has joined on-chain
  // (StartFinalized). While we have no board: poll the chain to notice the
  // join, and keep re-watching so the screen wakes itself up — no reload.
  useEffect(() => {
    if (casualRole != null || state !== null || role === null) return;
    const cfg = escrowConfig();
    if (!cfg) return;
    const iv = setInterval(async () => {
      socket.current?.emit("watch", { matchId: matchId.toString(), player: role ?? undefined });
      if (waitingOpen) {
        try {
          const client = publicClient(cfg.rpcUrl, cfg.chainId);
          const m = (await readContract(client, {
            address: cfg.escrow,
            abi: matchEscrowAbi,
            functionName: "getMatch",
            args: [matchId],
          })) as { status: number };
          if (Number(m.status) !== 1) setWaitingOpen(false);
        } catch {
          /* transient read failure — try again next tick */
        }
      }
    }, 4000);
    return () => clearInterval(iv);
  }, [casualRole, state === null, role === null, waitingOpen, matchId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The invitee takes their seat: approve if needed, stake the same amount,
  // then reload — the mount flow reruns and finds them as player 1.
  async function joinThisMatch() {
    const cfg = escrowConfig();
    if (!cfg || !wallet.current || !myAddress.current || !joinOffer || joiningNow) return;
    setJoiningNow(true);
    setJoinError(null);
    try {
      const client = publicClient(cfg.rpcUrl, cfg.chainId);
      const allowance = (await readContract(client, {
        address: joinOffer.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [myAddress.current, cfg.escrow],
      })) as bigint;
      if (allowance < joinOffer.stake) {
        const ah = await approve(wallet.current, {
          account: myAddress.current,
          token: joinOffer.token,
          spender: cfg.escrow,
          amount: joinOffer.stake,
          feeCurrency: feeCurrency.current,
        });
        await client.waitForTransactionReceipt({ hash: ah });
      }
      const sk = createSessionKey();
      persistSession(matchId, sk);
      recordLocalMatch(matchId);
      const jh = await joinMatch(wallet.current, {
        account: myAddress.current,
        escrow: cfg.escrow,
        matchId,
        session: sk.address,
        feeCurrency: feeCurrency.current,
      });
      await client.waitForTransactionReceipt({ hash: jh });
      track("match_joined");
      window.location.reload();
    } catch (e) {
      setJoinError(humanizeError(e));
      setJoiningNow(false);
    }
  }

  // Staking must feel reversible: an open match nobody joined refunds in full.
  async function cancelOpenMatch() {
    const cfg = escrowConfig();
    if (!cfg || !wallet.current || !myAddress.current || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelMatch(wallet.current, {
        account: myAddress.current,
        escrow: cfg.escrow,
        matchId,
        feeCurrency: feeCurrency.current,
      });
      window.location.href = "/";
    } catch (e) {
      setCancelError(humanizeError(e));
      setCancelling(false);
    }
  }

  function shareMatchInvite() {
    const url = `${window.location.origin}/play?match=${matchId.toString()}`;
    const data = { title: "Awalé", text: `Join my Awalé match #${matchId.toString()}`, url };
    if (navigator.share) navigator.share(data).catch(() => {});
    else
      navigator.clipboard?.writeText(url).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
  }

  // Poll the chain while an on-chain ending is pending: flag fell (opponent
  // may claim), our claim/dispute is in flight, or a real claim exists. Ends
  // in a proper resolution screen for BOTH sides.
  useEffect(() => {
    if (casualRole != null || chainEnded || !(timedOut || settleWatch || theirClaim)) return;
    const cfg = escrowConfig();
    if (!cfg) return;
    const iv = setInterval(async () => {
      try {
        const client = publicClient(cfg.rpcUrl, cfg.chainId);
        const m = (await readContract(client, {
          address: cfg.escrow,
          abi: matchEscrowAbi,
          functionName: "getMatch",
          args: [matchId],
        })) as { status: number; proposedWinner: number };
        const st = Number(m.status);
        if (st === 4) {
          // Resolved — the pot has been paid out
          const won = Number(m.proposedWinner) === roleRef.current;
          setChainEnded(won ? "won" : "lost");
          setOutcome(won ? 0 : 1);
          setTimedOut(false);
          setTheirClaim(null);
          setClaimStatus(won ? "Paid ✓ — your winnings are in your wallet." : null);
          setStatus(won ? "You win — paid out ✅" : "You lose — out of time");
        } else if (st >= 5) {
          // Cancelled/Voided — both stakes went back in full
          setChainEnded("refunded");
          setTimedOut(false);
          setTheirClaim(null);
          setClaimStatus(null);
          setStatus("Match expired — stakes refunded");
        }
      } catch {
        /* transient read failure — next tick */
      }
    }, 10_000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timedOut, settleWatch, theirClaim !== null, chainEnded, casualRole, matchId]);

  const myTurn = state !== null && role !== null && !state.over && state.turn === role && !timedOut && !chainEnded;
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

      {connLost && state && !state.over && (
        <div className="row animate-in" style={{ justifyContent: "center" }}>
          <span className="chip" style={{ boxShadow: "inset 0 0 0 1px rgba(255,122,118,0.45)" }}>
            <span className="dot pulse" /> Connection lost — reconnecting… your clock keeps running
          </span>
        </div>
      )}

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

      {timedOut && state && !state.over && !chainEnded && (
        <div className="card stack animate-in" style={{ gap: 6, textAlign: "center" }}>
          <span className="muted">⏱ Your time ran out — {displayName(oppAddr)} can take the pot.</span>
          <span className="faint" style={{ fontSize: 12 }}>
            <span className="dot pulse" /> Waiting for the result…
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
      ) : joinOffer ? (
        // the invite link's landing: take the empty seat right here
        <div className="card stack animate-in" style={{ gap: 12, alignItems: "center", textAlign: "center" }}>
          <span className="chip gold">Match #{matchId.toString()}</span>
          <span className="h2">You&apos;re invited to a money match</span>
          <span className="muted">
            You each stake {fmt(joinOffer.stake, STAKE_DECIMALS)} · winner takes{" "}
            {fmt(computePayout(joinOffer.stake, joinOffer.rakeBps).prize, STAKE_DECIMALS)} {STAKE_SYMBOL}. Stakes are
            held by the match contract until the game settles.
          </span>
          <button className="btn block" onClick={joinThisMatch} disabled={joiningNow}>
            {joiningNow ? "Joining…" : `Stake ${fmt(joinOffer.stake, STAKE_DECIMALS)} ${STAKE_SYMBOL} & play`}
          </button>
          <span className="faint" style={{ fontSize: 11.5 }}>
            18+ · only stake what you can afford to lose
          </span>
          {joinError && (
            <span className="muted" style={{ color: "var(--danger)" }}>
              {joinError}
            </span>
          )}
        </div>
      ) : waitingOpen ? (
        // created but nobody joined yet — say so, hand out the invite, and keep
        // the exit visible: money locked in a lobby with no way back is churn.
        // The polling effect above swaps the board in the moment someone joins.
        <div className="stack" style={{ gap: 10 }}>
        {wallet.current && myAddress.current && stakeInfo.current && escrowConfig() && (
          <CrossMatchOffer
            myMatchId={matchId}
            myStake={stakeInfo.current.stake}
            wallet={wallet.current}
            account={myAddress.current}
            cfg={escrowConfig()!}
            feeCurrency={feeCurrency.current}
          />
        )}
        <div className="card stack animate-in" style={{ gap: 12, alignItems: "center", textAlign: "center" }}>
          <span className="chip positive">
            <span className="dot pulse" /> Waiting for an opponent
          </span>
          {stakeInfo.current && (
            <span className="muted">
              Your {fmt(stakeInfo.current.stake, STAKE_DECIMALS)} {STAKE_SYMBOL} is in the pot. Share the invite — the
              board appears the moment someone joins.
            </span>
          )}
          <button className="btn block" onClick={shareMatchInvite}>
            {copied ? "Link copied ✓" : "Invite an opponent"}
          </button>
          <button className="btn secondary block" onClick={cancelOpenMatch} disabled={cancelling}>
            {cancelling ? "Cancelling…" : "Cancel & refund"}
          </button>
          <span className="faint" style={{ fontSize: 12 }}>
            No one joined yet — cancel anytime and your stake comes back in full.
          </span>
          {cancelError && <span className="muted" style={{ color: "var(--danger)" }}>{cancelError}</span>}
        </div>
        </div>
      ) : (
        <div className="card">
          <span className="chip">
            <span className="dot pulse" />
            {status}
          </span>
        </div>
      )}

      {chainEnded === "refunded" && (
        <div className="card stack animate-in" style={{ gap: 10, alignItems: "center", textAlign: "center" }}>
          <span className="h2">Match expired</span>
          <span className="muted">Nobody claimed the result in time — both stakes were refunded in full.</span>
          <Link className="btn block" href="/?play=1">
            <Icon name="play" size={17} /> Play again
          </Link>
        </div>
      )}

      {outcome !== null && (state?.over || chainEnded === "won" || chainEnded === "lost") && (
        <GameOverlay
          result={outcome}
          stats={{ mine: myScore ?? 0, opp: oppScore ?? 0, moves: ply }}
          payout={
            outcome === 0 && stakeInfo.current
              ? `${fmt(computePayout(stakeInfo.current.stake, stakeInfo.current.rakeBps).prize, STAKE_DECIMALS)} ${STAKE_SYMBOL}`
              : undefined
          }
          saveHref={
            // a money win just scored league points — hand the winner the race
            // they're now in, not a Season page whose deposits may be closed
            outcome === 0 && stakeInfo.current ? "/compete" : undefined
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
