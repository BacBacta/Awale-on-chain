"use client";

// Drives a player through a tournament bracket: polls the server for the current
// obligation, then either hosts (creates) or joins the async game for that round,
// reusing the correspondence play surface. When a game ends it reports the winner
// and waits for the next round. The lower-address player is the deterministic host,
// so both clients agree on who creates without extra handshaking.

import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { Icon } from "./Icon.js";
import { AsyncMatch } from "./AsyncMatch.js";
import { getInjectedProvider, connect } from "../lib/minipay.js";
import { escrowConfig } from "../lib/escrow.js";
import { createSessionKey, persistSession } from "../lib/session.js";
import { createAsync, getAsync, recordAsyncMatch } from "../lib/asyncClient.js";
import { displayName } from "../lib/names.js";
import { myGame, reportGameCreated, reportGameResult, type Assignment } from "../lib/tournaments.js";

type View =
  | { kind: "connecting" }
  | { kind: "waiting"; label: string }
  | { kind: "playing"; matchId: string; assignment: Assignment };

export function TournamentCoordinator({ id }: { id: string }) {
  const [account, setAccount] = useState<Address | null>(null);
  const [view, setView] = useState<View>({ kind: "connecting" });
  const reported = useRef<Set<string>>(new Set()); // "round:index" already reported

  // connect (read-only is fine for polling; play needs the wallet via AsyncMatch)
  useEffect(() => {
    const cfg = escrowConfig();
    const provider = getInjectedProvider();
    if (!provider || !cfg) {
      setView({ kind: "waiting", label: "Connect a wallet to play the tournament." });
      return;
    }
    connect(provider, cfg.chainId)
      .then((c) => setAccount(c.address))
      .catch(() => setView({ kind: "waiting", label: "Connect a wallet to play the tournament." }));
  }, []);

  // poll the bracket for the current obligation
  useEffect(() => {
    if (!account) return;
    let stop = false;

    async function tick() {
      const a = await myGame(id, account!).catch(() => null);
      if (stop) return;

      if (!a) {
        setView({ kind: "waiting", label: "Waiting for your next game…" });
        return;
      }
      const key = `${a.round}:${a.index}`;

      // if the game we're seated in just finished, report and move on
      if (a.asyncMatchId && !reported.current.has(key)) {
        const s = await getAsync(a.asyncMatchId).catch(() => null);
        if (s?.over) {
          // winner index from the game state; a draw advances the host deterministically
          const winnerIdx = s.state.winner === 2 ? null : s.state.winner;
          const winner =
            winnerIdx === null
              ? (a.role === "host" ? account! : a.opponent)
              : (s.players[winnerIdx] as Address);
          reported.current.add(key);
          await reportGameResult(id, a.round, a.index, winner);
          setView({ kind: "waiting", label: "Round complete — waiting for the next game…" });
          return;
        }
      }

      // host: create the async game once, then play it
      if (a.role === "host" && !a.asyncMatchId) {
        const session = createSessionKey();
        const matchId = await createAsync(session.address);
        persistSession(BigInt(matchId), session);
        recordAsyncMatch(matchId);
        await reportGameCreated(id, a.round, a.index, matchId);
        setView({ kind: "playing", matchId, assignment: a });
        return;
      }
      // guest: wait for the host to create, then play it (AsyncMatch joins)
      if (a.role === "guest" && !a.asyncMatchId) {
        setView({ kind: "waiting", label: `Waiting for ${displayName(a.opponent)} to start the game…` });
        return;
      }
      if (a.asyncMatchId) {
        setView({ kind: "playing", matchId: a.asyncMatchId, assignment: a });
      }
    }

    tick();
    const iv = setInterval(tick, 4000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [account, id]);

  if (view.kind === "playing") {
    return (
      <div className="stack" style={{ flex: 1 }}>
        <div className="row pad" style={{ paddingBottom: 0, justifyContent: "space-between" }}>
          <span className="chip gold">
            <Icon name="medal" size={14} /> Tournament · vs {displayName(view.assignment.opponent)}
          </span>
        </div>
        <AsyncMatch matchId={view.matchId} />
      </div>
    );
  }

  return (
    <main className="pad stack" style={{ flex: 1, gap: 14, alignItems: "center", justifyContent: "center" }}>
      <span className="lead gold" style={{ width: 56, height: 56, borderRadius: 18 }}>
        <Icon name={view.kind === "connecting" ? "spinner" : "medal"} size={28} />
      </span>
      <span className="h2" style={{ textAlign: "center" }}>
        {view.kind === "connecting" ? "Joining the bracket…" : view.label}
      </span>
      <span className="chip">
        <span className="dot pulse" /> Tournament #{id}
      </span>
    </main>
  );
}
