"use client";

import { useEffect, useState } from "react";
import { LocalDemo } from "../../src/components/LocalDemo.js";
import { LiveMatch } from "../../src/components/LiveMatch.js";

// /play                          -> self-contained demo vs a bot
// /play?match=N                  -> live on-chain match #N over the game server
// /play?match=N&casual=1&role=0  -> off-chain casual Quick Match (role from matchmaking)
export default function Play() {
  const [match, setMatch] = useState<string | null>(null);
  const [casualRole, setCasualRole] = useState<0 | 1 | undefined>(undefined);
  const [opp, setOpp] = useState<`0x${string}` | undefined>(undefined);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setMatch(q.get("match"));
    if (q.get("casual") === "1") setCasualRole(q.get("role") === "1" ? 1 : 0);
    const o = q.get("opp");
    if (o && o.startsWith("0x")) setOpp(o as `0x${string}`);
    setReady(true);
  }, []);

  if (!ready) return null;
  return match ? (
    <LiveMatch matchId={BigInt(match)} casualRole={casualRole} opponentAddress={opp} />
  ) : (
    <LocalDemo />
  );
}
