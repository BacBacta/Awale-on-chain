"use client";

// The "two waiting rooms that never meet" fix. Both friends tap create, both
// sit in their own static "Waiting for an opponent" screen, and nothing ever
// converges — observed three times in real two-player tests. This card polls
// the lobby while you wait and, when someone ELSE is waiting with the SAME
// stake on an OLDER match, offers to play them now: it joins their match and
// then cancels yours (full refund).
//
// Deterministic tie-break: the offer only shows for matches OLDER than yours
// (lower id). The later creator moves; the earlier creator's room fills up on
// its own — so both sides always converge on the same match, never cross.

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { cancelMatch, type WriteClient, type EscrowConfig } from "../lib/escrow.js";
import { listOpenMatches, joinOpenMatch, type OpenMatch } from "../lib/lobby.js";
import { friendlyName } from "../lib/names.js";
import { fmt } from "../lib/money.js";
import { humanizeError } from "../lib/errors.js";

const STAKE_DECIMALS = Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "18");
const STAKE_SYMBOL = process.env.NEXT_PUBLIC_STAKE_SYMBOL ?? "USDC";
const POLL_MS = 8000;

export function CrossMatchOffer({
  myMatchId,
  myStake,
  wallet,
  account,
  cfg,
  feeCurrency,
}: {
  myMatchId: bigint;
  myStake: bigint;
  wallet: WriteClient;
  account: Address;
  cfg: EscrowConfig;
  feeCurrency?: Address;
}) {
  const [offer, setOffer] = useState<OpenMatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const list = await listOpenMatches(cfg, account, 15);
        if (!alive) return;
        const match = list.find((o) => !o.mine && o.id < myMatchId && o.stake === myStake);
        setOffer(match ?? null);
      } catch {
        /* transient — keep the last offer */
      }
    };
    void check();
    const iv = setInterval(check, POLL_MS);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [cfg, account, myMatchId, myStake]);

  if (!offer) return null;

  async function playThem() {
    if (!offer || busy) return;
    setBusy(true);
    setNote(null);
    try {
      // join THEIR (older) match first — the game is the point; then bring
      // our own stake home. If someone joined ours in the meantime, the
      // cancel reverts harmlessly and Your matches still shows both games.
      await joinOpenMatch({ wallet, account, cfg, matchId: offer.id, feeCurrency });
      try {
        await cancelMatch(wallet, { account, escrow: cfg.escrow, matchId: myMatchId, feeCurrency });
      } catch {
        setNote("Heads up: your own match got joined too — check Your matches after this game.");
      }
      window.location.href = `/play?match=${offer.id.toString()}`;
    } catch (e) {
      setNote(humanizeError(e));
      setBusy(false);
    }
  }

  return (
    <div className="card stack animate-in" style={{ gap: 10, alignItems: "center", textAlign: "center", boxShadow: "inset 0 0 0 1.5px rgba(246,200,99,0.5)" }}>
      <span style={{ fontWeight: 700, fontSize: 14.5 }}>
        🎯 {friendlyName(offer.creator)} is waiting with the same stake!
      </span>
      <button className="btn block" onClick={playThem} disabled={busy}>
        {busy ? "Joining…" : `Play them now — ${fmt(offer.stake, STAKE_DECIMALS)} ${STAKE_SYMBOL}`}
      </button>
      <span className="faint" style={{ fontSize: 11.5 }}>
        Your own match is cancelled and refunded automatically.
      </span>
      {note && <span className="muted">{note}</span>}
    </div>
  );
}
