"use client";

import { useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { Address } from "viem";
import { createSessionKey, persistSession } from "../lib/session.js";
import { getProfile } from "../lib/profile.js";
import { Icon } from "./Icon.js";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";
const FALLBACK_MS = 12_000; // no human in this long → play the AI instead

// Casual Quick Match: queue on the server's ELO matchmaker and jump into an
// off-chain live game on pairing. If no opponent shows up, fall back to the AI
// so the primary CTA *always* yields a game (never a dead-end spinner).
export function QuickMatch({ account }: { account?: Address }) {
  const [phase, setPhase] = useState<"idle" | "searching" | "fallback">("idle");
  const sockRef = useRef<Socket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    setPhase("searching");
    const session = createSessionKey();
    const sock = io(SERVER_URL, { transports: ["websocket"] });
    sockRef.current = sock;

    timerRef.current = setTimeout(toBot, FALLBACK_MS);

    sock.on("connect", async () => {
      // pair on the player's real skill rating when they have one
      const elo = account ? ((await getProfile(account))?.elo ?? 1200) : 1200;
      sock.emit("queue", { address: account ?? session.address, elo, mode: "casual", sessionPubKey: session.address });
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

  if (!SERVER_URL) {
    // server not configured — still give a game: straight to the AI
    return (
      <a className="btn block" href="/play" style={{ fontSize: 16, padding: "16px 18px" }}>
        <Icon name="bolt" size={18} /> Quick match
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
    <button className="btn block" onClick={find} style={{ fontSize: 16, padding: "16px 18px" }}>
      <Icon name="bolt" size={18} /> Quick match
    </button>
  );
}
