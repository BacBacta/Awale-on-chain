"use client";

import { useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { Address } from "viem";
import { createSessionKey, persistSession } from "../lib/session.js";
import { Icon } from "./Icon.js";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

// Casual Quick Match: queue on the server's ELO matchmaker, and on pairing jump
// straight into an off-chain live game — no match id to share, no stake.
export function QuickMatch({ account }: { account?: Address }) {
  const [searching, setSearching] = useState(false);
  const sockRef = useRef<Socket | null>(null);

  function cancel() {
    sockRef.current?.close();
    sockRef.current = null;
    setSearching(false);
  }

  function find() {
    if (!SERVER_URL || searching) return;
    setSearching(true);
    const session = createSessionKey();
    const sock = io(SERVER_URL, { transports: ["websocket"] });
    sockRef.current = sock;

    sock.on("connect", () => {
      // address is for display/ELO only; moves are signed by the session key
      sock.emit("queue", { address: account ?? session.address, elo: 1000, mode: "casual", sessionPubKey: session.address });
    });
    sock.on("matched", (msg: { matchId?: string; role?: 0 | 1; opponent?: string }) => {
      if (!msg.matchId) return;
      persistSession(BigInt(msg.matchId), session); // LiveMatch loads it by matchId
      sock.close();
      const opp = msg.opponent ? `&opp=${msg.opponent}` : "";
      window.location.href = `/play?match=${msg.matchId}&casual=1&role=${msg.role ?? 0}${opp}`;
    });
    sock.on("error", () => cancel());
    sock.on("connect_error", () => cancel());
  }

  if (!SERVER_URL) return null;

  return searching ? (
    <button className="btn block" onClick={cancel} style={{ fontSize: 16, padding: "16px 18px" }}>
      <Icon name="spinner" size={18} /> Finding an opponent… · tap to cancel
    </button>
  ) : (
    <button className="btn block" onClick={find} style={{ fontSize: 16, padding: "16px 18px" }}>
      <Icon name="bolt" size={18} /> Quick match
    </button>
  );
}
