"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { Address } from "viem";
import { createSessionKey, persistSession } from "../lib/session.js";
import { getProfile } from "../lib/profile.js";
import { track } from "../lib/analytics.js";
import { Icon } from "./Icon.js";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";
// AI-fallback window (P2-8): adaptive on the server's queue-depth hint. When
// the pool is empty nobody is coming soon, so fall back fast; when a human
// candidate is already waiting, give the pairing the full window. Never exceed
// the max, never remove the fallback (the CTA must always yield a game).
const FALLBACK_MAX_MS = 12_000;
const FALLBACK_EMPTY_MS = 6_000;

// Casual Quick Match: queue on the server's ELO matchmaker and jump into an
// off-chain live game on pairing. If no opponent shows up, fall back to the AI
// so the primary CTA *always* yields a game (never a dead-end spinner).
// `autoStart` fires the search immediately on mount — used when another screen
// links here to actually *start a game* (e.g. Compete's "Play your first
// game"), so the button delivers a game rather than dumping the player home.
export function QuickMatch({ account, autoStart }: { account?: Address; autoStart?: boolean }) {
  const [phase, setPhase] = useState<"idle" | "searching" | "fallback">("idle");
  const sockRef = useRef<Socket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoFired = useRef(false);

  function clearTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function cancel() {
    clearTimer();
    sockRef.current?.close();
    sockRef.current = null;
    setPhase("idle");
  }

  function toBot() {
    clearTimer();
    sockRef.current?.close();
    sockRef.current = null;
    setPhase("fallback");
    setTimeout(() => (window.location.href = "/play"), 1400);
  }

  function find() {
    if (!SERVER_URL || phase !== "idle") return;
    track("quick_match_start");
    setPhase("searching");
    const session = createSessionKey();
    const sock = io(SERVER_URL, { transports: ["websocket"] });
    sockRef.current = sock;

    // start with the max window; the server's queue-ack may shorten it
    timerRef.current = setTimeout(toBot, FALLBACK_MAX_MS);

    sock.on("connect", async () => {
      // pair on the player's real skill rating when they have one
      const elo = account ? ((await getProfile(account))?.elo ?? 1200) : 1200;
      sock.emit("queue", { address: account ?? session.address, elo, mode: "casual", sessionPubKey: session.address });
    });
    // adaptive fallback: empty pool ⇒ fall back at 6s; a candidate exists ⇒
    // keep the full 12s. Only ever SHORTENS the wait, never extends past max.
    sock.on("queue-ack", (msg: { depth: number }) => {
      if (msg.depth === 0 && timerRef.current) {
        clearTimer();
        timerRef.current = setTimeout(toBot, FALLBACK_EMPTY_MS);
      }
    });
    sock.on("matched", (msg: { matchId?: string; role?: 0 | 1; opponent?: string }) => {
      if (!msg.matchId) return;
      clearTimer();
      persistSession(BigInt(msg.matchId), session);
      sock.close();
      const opp = msg.opponent ? `&opp=${msg.opponent}` : "";
      window.location.href = `/play?match=${msg.matchId}&casual=1&role=${msg.role ?? 0}${opp}`;
    });
    sock.on("error", () => toBot());
    sock.on("connect_error", () => toBot());
  }

  // fire once when asked to auto-start (guarded against React's double-mount)
  useEffect(() => {
    if (autoStart && !autoFired.current) {
      autoFired.current = true;
      find();
    }
  }, [autoStart]); // eslint-disable-line react-hooks/exhaustive-deps

  // One-line promise under the label: a first-time player must know what the
  // button costs (nothing) and what it starts (a live game vs a real person).
  const face = (
    <span className="col" style={{ gap: 2, alignItems: "center" }}>
      <span className="row" style={{ gap: 8 }}>
        <Icon name="bolt" size={18} /> Quick match
      </span>
      <span style={{ fontSize: 11.5, fontWeight: 500, opacity: 0.75 }}>Free · live vs a real player</span>
    </span>
  );

  if (!SERVER_URL) {
    // server not configured — still give a game: straight to the AI
    return (
      <a className="btn block" href="/play" style={{ fontSize: 16, padding: "12px 18px" }}>
        {face}
      </a>
    );
  }

  if (phase === "fallback") {
    return (
      <button className="btn block" disabled style={{ fontSize: 16, padding: "16px 18px" }}>
        <Icon name="spinner" size={18} /> No one around — starting vs AI…
      </button>
    );
  }

  return phase === "searching" ? (
    <button className="btn block" onClick={cancel} style={{ fontSize: 16, padding: "16px 18px" }}>
      <Icon name="spinner" size={18} /> Finding an opponent… · tap to cancel
    </button>
  ) : (
    <button className="btn block" onClick={find} style={{ fontSize: 16, padding: "12px 18px" }}>
      {face}
    </button>
  );
}
