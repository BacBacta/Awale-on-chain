"use client";

import { useEffect, useState } from "react";
import { LocalDemo } from "../../src/components/LocalDemo.js";
import { LiveMatch } from "../../src/components/LiveMatch.js";

// /play         -> self-contained demo vs a bot
// /play?match=N -> live match #N played over the game server
export default function Play() {
  const [match, setMatch] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setMatch(new URLSearchParams(window.location.search).get("match"));
    setReady(true);
  }, []);

  if (!ready) return null;
  return match ? <LiveMatch matchId={BigInt(match)} /> : <LocalDemo />;
}
