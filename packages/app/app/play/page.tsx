"use client";

import { useEffect, useState } from "react";
import { LocalDemo } from "../../src/components/LocalDemo.js";
import { LiveMatch } from "../../src/components/LiveMatch.js";
import { AsyncMatch } from "../../src/components/AsyncMatch.js";
import { TournamentCoordinator } from "../../src/components/TournamentCoordinator.js";

// /play                          -> self-contained demo vs the AI
// /play?match=N                  -> live on-chain match #N over the game server
// /play?match=N&casual=1&role=0  -> off-chain casual Quick Match
// /play?async=<id>               -> correspondence (async) match, played over HTTP
// /play?tournament=<id>          -> tournament bracket coordinator (hosts/joins each round)
export default function Play() {
  const [match, setMatch] = useState<string | null>(null);
  const [asyncId, setAsyncId] = useState<string | null>(null);
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const [casualRole, setCasualRole] = useState<0 | 1 | undefined>(undefined);
  const [opp, setOpp] = useState<`0x${string}` | undefined>(undefined);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setAsyncId(q.get("async"));
    setMatch(q.get("match"));
    setTournamentId(q.get("tournament"));
    if (q.get("casual") === "1") setCasualRole(q.get("role") === "1" ? 1 : 0);
    const o = q.get("opp");
    if (o && o.startsWith("0x")) setOpp(o as `0x${string}`);
    setReady(true);
  }, []);

  if (!ready) return null;
  if (tournamentId) return <TournamentCoordinator id={tournamentId} />;
  if (asyncId) return <AsyncMatch matchId={asyncId} />;
  return match ? (
    <LiveMatch matchId={BigInt(match)} casualRole={casualRole} opponentAddress={opp} />
  ) : (
    <LocalDemo />
  );
}
