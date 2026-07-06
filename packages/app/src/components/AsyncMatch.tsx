"use client";

import { useEffect, useRef, useState } from "react";
import { humanizeError } from "../lib/errors.js";
import Link from "next/link";
import type { Hex } from "viem";
import { legalMovesMask, type GameState } from "../../../engine/src/awale.js";
import { Board } from "./Board.js";
import { PlayerPanel } from "./PlayerPanel.js";
import { Icon } from "./Icon.js";
import { SoundToggle } from "./SoundToggle.js";
import { GameOverlay } from "./GameOverlay.js";
import { createSessionKey, loadSession, persistSession, signMove, signResign, type SessionKey } from "../lib/session.js";
import { escrowConfig } from "../lib/escrow.js";
import { getEquipped, type EquippedSkin } from "../lib/skins.js";
import { displayName } from "../lib/names.js";
import { sfx } from "../lib/sound.js";
import {
  getAsync,
  joinAsync,
  moveAsync,
  claimTimeoutAsync,
  resignAsync,
  roleOf,
  recordAsyncMatch,
  createAsync,
  ASYNC_TURN_CLOCK_MS,
  type AsyncState,
} from "../lib/asyncClient.js";
import { recordOpponent } from "../lib/social.js";

const POLL_MS = 3500;

export function AsyncMatch({ matchId }: { matchId: string }) {
  const [data, setData] = useState<AsyncState | null>(null);
  const [role, setRole] = useState<0 | 1 | null>(null);
  const [status, setStatus] = useState("Loading…");
  const [skin, setSkin] = useState<EquippedSkin | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const session = useRef<SessionKey | null>(null);
  const cfg = escrowConfig();
  const prevTurn = useRef<number | null>(null);

  useEffect(() => {
    setSkin(getEquipped());
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    (async () => {
      try {
        let s = await getAsync(matchId);
        let sk = loadSession(BigInt(matchId));

        if (!sk) {
          if (s.open) {
            // visitor opening an invite → join as player 1
            sk = createSessionKey();
            s = await joinAsync(matchId, sk.address);
            persistSession(BigInt(matchId), sk);
            recordAsyncMatch(matchId);
          } else {
            setStatus("This game is full.");
            setData(s);
            return;
          }
        }
        session.current = sk;
        const r = roleOf(s, sk.address);
        if (alive) {
          setRole(r);
          setData(s);
          try {
            localStorage.setItem("awale_played", "1");
          } catch {
            /* ignore */
          }
        }

        if (!s.open && r !== null) recordOpponent(r === 0 ? s.players[1] : s.players[0]);

        timer = setInterval(async () => {
          try {
            const next = await getAsync(matchId);
            if (!alive) return;
            if (!next.open && r !== null) recordOpponent(r === 0 ? next.players[1] : next.players[0]);
            // "your turn" cue when the opponent has just moved
            if (prevTurn.current !== null && next.turn !== prevTurn.current && r !== null && next.turn === r && !next.over) {
              sfx("select");
            }
            prevTurn.current = next.turn;
            setData(next);
          } catch {
            /* transient — keep last state */
          }
        }, POLL_MS);
      } catch (e) {
        if (alive) setStatus(humanizeError(e));
      }
    })();

    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [matchId]);

  async function play(house: number) {
    if (!data || !session.current || !cfg || role === null) return;
    if (data.over || data.open || data.turn !== role) return;
    try {
      const sig = await signMove(session.current, BigInt(matchId), BigInt(data.ply), house, {
        chainId: BigInt(cfg.chainId),
        verifier: cfg.verifier,
      });
      const state = await moveAsync(matchId, role, house, sig as Hex);
      setData({ ...data, state, turn: 1 - role, ply: data.ply + 1, over: state.over });
    } catch (e) {
      setStatus(humanizeError(e));
    }
  }

  async function claimTimeout() {
    if (!data || role === null) return;
    try {
      const state = await claimTimeoutAsync(matchId, role);
      setData({ ...data, state, over: state.over });
    } catch (e) {
      setStatus(humanizeError(e));
    }
  }

  async function leaveGame() {
    if (!data || !session.current || !cfg || role === null || data.over || data.open) return;
    try {
      // sign the resign with our session key (bound to the current ply), exactly
      // as a move is signed — the server rejects an unsigned or forged forfeit
      const sig = await signResign(session.current, BigInt(matchId), BigInt(data.ply), {
        chainId: BigInt(cfg.chainId),
        verifier: cfg.verifier,
      });
      const state = await resignAsync(matchId, role, sig as Hex);
      setData({ ...data, state, over: state.over });
    } catch (e) {
      setStatus(humanizeError(e));
    }
  }

  const inviteUrl = typeof window !== "undefined" ? `${window.location.origin}/play?async=${matchId}` : "";
  async function copyInvite() {
    // native share sheet first (best on mobile); if it's unavailable or the
    // user cancels, fall back to the clipboard. Either way we confirm on
    // screen — and the link is shown below so it ALWAYS works, even when the
    // MiniPay webview blocks both share and clipboard (that silent failure was
    // the "nothing happens" bug).
    try {
      if (navigator.share) {
        await navigator.share({ title: "Awalé", text: "Join my Awalé game", url: inviteUrl });
        return;
      }
    } catch {
      /* share cancelled/blocked — fall through to copy */
    }
    try {
      await navigator.clipboard?.writeText(inviteUrl);
    } catch {
      /* clipboard blocked — the link on screen can be copied by hand */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function rematch() {
    try {
      const ns = createSessionKey();
      const id = await createAsync(ns.address);
      persistSession(BigInt(id), ns);
      recordAsyncMatch(id);
      window.location.href = `/play?async=${id}`;
    } catch (e) {
      setStatus(humanizeError(e));
    }
  }

  if (!data) {
    return (
      <main className="pad stack" style={{ flex: 1, gap: 12 }}>
        <Link className="btn ghost" href="/" style={{ alignSelf: "flex-start", padding: "6px 10px" }}>
          <Icon name="back" size={16} /> Back
        </Link>
        <div className="card">
          <span className="chip">
            <span className="dot pulse" /> {status}
          </span>
        </div>
      </main>
    );
  }

  const r = role ?? 0;
  const myScore = r === 1 ? data.state.store1 : data.state.store0;
  const oppScore = r === 1 ? data.state.store0 : data.state.store1;
  const myTurn = !data.over && !data.open && data.turn === r;
  const playable = myTurn ? legalHouses(data.state) : [];
  const outcome: 0 | 1 | 2 | null = data.over ? (data.state.winner === 2 ? 2 : data.state.winner === r ? 0 : 1) : null;

  const oppName = displayName(data.open ? null : data.players[1 - r]);
  // inactivity model: the opponent has `grace` from their last move; once it
  // lapses the waiting player can claim the win. Shown as a live countdown so
  // the table never just "sits there waiting for their return".
  const grace = data.turnClockMs ?? ASYNC_TURN_CLOCK_MS;
  const sinceMove = Math.max(0, Date.now() - data.updatedAt);
  const waitingOnOpp = !data.over && !data.open && !myTurn;
  const claimable = waitingOnOpp && sinceMove >= grace;
  const claimInMs = Math.max(0, grace - sinceMove);

  const statusLabel = data.open
    ? "Waiting for an opponent to join"
    : data.over
      ? "Game over"
      : myTurn
        ? "Your turn"
        : `Waiting for ${oppName}`;

  return (
    <main className="stack" style={{ flex: 1, gap: 14, position: "relative", padding: "12px 8px" }}>
      <div className="row" style={{ padding: "0 6px" }}>
        <Link className="btn ghost" href="/" style={{ padding: "6px 10px" }}>
          <Icon name="back" size={16} /> Back
        </Link>
        <span className="row" style={{ gap: 8 }}>
          <span className="chip">
            {data.turnClockMs != null ? `⏱ ${Math.round(data.turnClockMs / 60_000)} min/move` : "play anytime"}
          </span>
          <SoundToggle />
        </span>
      </div>

      {data.open && (
        <div className="card stack" style={{ gap: 12, alignItems: "center", textAlign: "center" }}>
          <span className="chip positive">
            <span className="dot pulse" /> Waiting for an opponent
          </span>
          <span className="muted">Send this link — your friend joins and plays whenever. You&apos;ll be notified to come back.</span>
          {/* the link is always visible & selectable, so inviting works even if
              the webview blocks the share sheet and the clipboard */}
          <input
            readOnly
            value={inviteUrl}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Invite link"
            className="input"
            style={{ fontSize: 12.5, textAlign: "center", width: "100%" }}
          />
          <button className="btn block" onClick={copyInvite}>
            <Icon name="share" size={17} /> {copied ? "Link copied ✓" : "Copy invite link"}
          </button>
        </div>
      )}

      <div className="stack" style={{ gap: 14, marginTop: 4 }}>
        <PlayerPanel name={displayName(data.open ? null : data.players[1 - r])} score={oppScore} active={!data.over && !data.open && data.turn !== r} />
        <Board state={data.state} perspective={r} onPlay={play} playable={playable} skin={skin} />
        <PlayerPanel name="You" you score={myScore} active={myTurn} />
      </div>

      <div className="row" style={{ justifyContent: "center" }}>
        <span className={`chip ${myTurn ? "positive" : ""}`}>
          {!data.over && <span className={`dot ${myTurn ? "pulse" : ""}`} />}
          {statusLabel}
        </span>
      </div>

      {/* Waiting on the opponent: say how long it's been and — crucially —
          when this resolves. A friend who left no longer leaves the other
          staring at a silent board. */}
      {waitingOnOpp && !claimable && (
        <div className="card stack animate-in" style={{ gap: 6, alignItems: "center", textAlign: "center", padding: "14px 16px" }}>
          <span className="muted">
            {oppName} last played {humanizeDuration(sinceMove)} ago.
          </span>
          <span className="faint">
            If they don&apos;t come back, you can claim the win in {humanizeDuration(claimInMs)}.
          </span>
        </div>
      )}

      {claimable && (
        <div className="card stack animate-in" style={{ gap: 10, alignItems: "center", textAlign: "center", padding: "16px" }}>
          <span className="muted">{oppName} left the game without playing.</span>
          <button className="btn block" onClick={claimTimeout}>
            <Icon name="trophy" size={17} /> Claim the win
          </button>
        </div>
      )}

      {/* Leave cleanly — the opponent is told and wins, instead of a dead table. */}
      {!data.over && !data.open && (
        <div className="row" style={{ justifyContent: "center", marginTop: 2 }}>
          {confirmLeave ? (
            <span className="row" style={{ gap: 8 }}>
              <button className="btn ghost" style={{ padding: "6px 12px", fontSize: 12.5 }} onClick={() => setConfirmLeave(false)}>
                Keep playing
              </button>
              <button className="btn ghost" style={{ padding: "6px 12px", fontSize: 12.5, color: "var(--danger)" }} onClick={leaveGame}>
                Yes, leave — opponent wins
              </button>
            </span>
          ) : (
            <button className="btn ghost" style={{ padding: "6px 12px", fontSize: 12.5, color: "var(--faint)" }} onClick={() => setConfirmLeave(true)}>
              Leave game
            </button>
          )}
        </div>
      )}

      <div className="spacer" />

      {outcome !== null && <GameOverlay result={outcome} stats={{ mine: myScore, opp: oppScore, moves: data.ply }} onPlayAgain={rematch} />}
    </main>
  );
}

function legalHouses(s: GameState): number[] {
  const mask = legalMovesMask(s);
  const out: number[] = [];
  for (let h = 0; h < 6; h++) if (mask & (1 << h)) out.push(h);
  return out;
}

/** Compact human duration: "2d 4h" / "3h 20m" / "12m" / "under a minute". */
function humanizeDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "under a minute";
}
