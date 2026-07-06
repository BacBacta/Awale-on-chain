"use client";

import { Icon } from "../../src/components/Icon.js";
import { STAKE_DECIMALS, STAKE_SYMBOL } from "../../src/lib/stake.js";
import { useEffect, useState } from "react";
import Link from "next/link";
import { readContract } from "viem/actions";
import type { Address } from "viem";
import { getInjectedProvider, connect, publicClient } from "../../src/lib/minipay.js";
import { escrowConfig, legacyEscrows, cancelMatch, voidExpired, finalizeResult } from "../../src/lib/escrow.js";
import { readWithRetry, confirmTx } from "../../src/lib/tx.js";
import { cachedOutcomes, scanSettled, type Outcome } from "../../src/lib/outcomes.js";
import { listLocalMatches, statusView } from "../../src/lib/matches.js";
import { computePayout, fmt } from "../../src/lib/money.js";
import { humanizeError } from "../../src/lib/errors.js";
import { matchEscrowAbi } from "../../../protocol/src/abis.js";
import { createSessionKey, persistSession } from "../../src/lib/session.js";
import { asyncEnabled, createAsync, recordAsyncMatch, listAsyncMatchIds, getAsync, roleOf } from "../../src/lib/asyncClient.js";
import { loadSession } from "../../src/lib/session.js";
import { displayName, friendlyName } from "../../src/lib/names.js";
import { listOpenMatches, joinOpenMatch, type OpenMatch } from "../../src/lib/lobby.js";
import type { WriteClient } from "../../src/lib/escrow.js";

const FEE_CURRENCY = (process.env.NEXT_PUBLIC_FEE_CURRENCY || undefined) as Address | undefined;

interface Row {
  id: bigint;
  /** the contract this match lives on — current escrow, or a legacy one for
   *  history that predates a redeploy. Every action targets THIS address. */
  escrow: Address;
  status: number;
  stake: bigint;
  rakeBps: number;
  /** match creator — the only wallet allowed to cancel an open match. */
  player0: Address;
  player1: Address;
  /** unix seconds; 0 until joined. Past it, a player can reclaim both stakes. */
  activeDeadline: number;
  /** unix seconds; set while a result is Proposed. */
  challengeDeadline: number;
  /** 0/1/2 — only meaningful while status is Proposed. */
  proposedWinner: number;
}

interface AsyncRow {
  id: string;
  opponent: string;
  yourTurn: boolean;
  open: boolean;
  over: boolean;
}

export default function Matches() {
  const [rows, setRows] = useState<Row[] | null>(null);
  // settled outcomes (winner + prize) per resolved match — so a finished row
  // says "You won / You lost / Draw", not a bare "Finished"
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [error, setError] = useState<string | null>(null);
  const [asyncRows, setAsyncRows] = useState<AsyncRow[]>([]);
  const [openMatches, setOpenMatches] = useState<OpenMatch[]>([]);
  const [wallet, setWallet] = useState<WriteClient | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [joining, setJoining] = useState<bigint | null>(null);

  // Connect (best-effort) and load the open-match lobby — staked games anyone can join.
  useEffect(() => {
    const cfg = escrowConfig();
    if (!cfg) return;
    (async () => {
      const provider = getInjectedProvider();
      let addr: Address | undefined;
      if (provider) {
        try {
          const c = await connect(provider, cfg.chainId);
          setWallet(c.wallet as unknown as WriteClient);
          setAccount((addr = c.address));
        } catch {
          /* read-only */
        }
      }
      try {
        setOpenMatches(await listOpenMatches(cfg, addr));
      } catch {
        /* best-effort */
      }
    })();
  }, []);

  async function joinOpen(matchId: bigint) {
    const cfg = escrowConfig();
    if (!cfg || joining !== null) return;
    // tapping Join is explicit intent — if a desktop wallet hasn't approved
    // the site yet, ask now instead of leaving the button dead
    let w = wallet;
    let a = account;
    if (!w || !a) {
      const provider = getInjectedProvider();
      if (!provider) return;
      try {
        const c = await connect(provider, cfg.chainId, { interactive: true });
        w = c.wallet as unknown as WriteClient;
        a = c.address;
        setWallet(w);
        setAccount(a);
      } catch {
        return; // user declined
      }
    }
    setJoining(matchId);
    try {
      await joinOpenMatch({ wallet: w, account: a, cfg, matchId, feeCurrency: FEE_CURRENCY });
      window.location.href = `/play?match=${matchId.toString()}`;
    } catch (e) {
      setError(humanizeError(e));
      setJoining(null);
    }
  }

  useEffect(() => {
    const ids = listAsyncMatchIds();
    if (ids.length === 0) return;
    Promise.all(
      ids.map(async (id) => {
        try {
          const s = await getAsync(id);
          const sk = loadSession(BigInt(id));
          const role = sk ? roleOf(s, sk.address) : null;
          return {
            id,
            opponent: s.open ? "Waiting for opponent" : displayName(role === 0 ? s.players[1] : s.players[0]),
            yourTurn: !s.over && !s.open && role !== null && s.turn === role,
            open: s.open,
            over: s.over,
          } as AsyncRow;
        } catch {
          return null;
        }
      }),
    ).then((r) => setAsyncRows(r.filter((x): x is AsyncRow => x !== null)));
  }, []);

  useEffect(() => {
    const cfg = escrowConfig();
    const ids = listLocalMatches();
    if (!cfg) {
      setError("Money matches aren’t available on this deployment.");
      setRows([]);
      return;
    }
    if (ids.length === 0) {
      setRows([]);
      return;
    }
    const client = publicClient(cfg.rpcUrl, cfg.chainId);
    // best-effort wallet connect so reads use the right chain (no prompt if denied)
    const provider = getInjectedProvider();
    let me: string | null = null;
    if (provider) connect(provider, cfg.chainId).then(({ address }) => (me = address.toLowerCase())).catch(() => {});
    // a player's matches span contract migrations — read the current escrow AND
    // any legacy ones, resolving each local id to the contract where it exists.
    const escrows = [cfg.escrow, ...legacyEscrows()];

    // allSettled, not all: one saved match id failing to read shouldn't blank
    // out every other match the player actually has.
    Promise.allSettled(
      ids.map(async (id): Promise<Row | null> => {
        for (const esc of escrows) {
          try {
            const m = (await readWithRetry(() =>
              readContract(client, { address: esc, abi: matchEscrowAbi, functionName: "getMatch", args: [id] }),
            )) as {
              status: number;
              stake: bigint;
              rakeBps: number;
              player0: Address;
              player1: Address;
              activeDeadline: bigint;
              challengeDeadline: bigint;
              proposedWinner: number;
            };
            if (Number(m.status) === 0) continue; // None on this contract — try the next
            if (me && m.player0.toLowerCase() !== me && m.player1.toLowerCase() !== me) continue;
            return {
              id,
              escrow: esc,
              status: Number(m.status),
              stake: m.stake,
              rakeBps: Number(m.rakeBps),
              player0: m.player0,
              player1: m.player1,
              activeDeadline: Number(m.activeDeadline),
              challengeDeadline: Number(m.challengeDeadline),
              proposedWinner: Number(m.proposedWinner),
            };
          } catch {
            /* try the next escrow */
          }
        }
        return null;
      }),
    ).then((results) => {
      const ok = results
        .filter((r): r is PromiseFulfilledResult<Row | null> => r.status === "fulfilled")
        .map((r) => r.value)
        .filter((r): r is Row => r !== null); // dropped: stale local id on no known contract
      setRows(ok);
      const failed = results.length - ok.length;
      if (failed > 0 && ok.length === 0) {
        setError(
          results.find((r) => r.status === "rejected")
            ? humanizeError((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)
            : null,
        );
      }
    });
  }, []);

  // resolve win/lose for finished matches from MatchSettled (cached forever).
  // Events are contract-scoped, so scan each match against ITS own escrow.
  useEffect(() => {
    const cfg = escrowConfig();
    if (!cfg || !rows) return;
    const resolved = rows.filter((r) => r.status === 4);
    if (resolved.length === 0) return;
    const merge = (m: Map<string, Outcome>) => {
      if (m.size === 0) return;
      setOutcomes((prev) => {
        const next = { ...prev };
        for (const [k, v] of m) next[k] = v;
        return next;
      });
    };
    merge(cachedOutcomes(resolved.map((r) => r.id)));
    const client = publicClient(cfg.rpcUrl, cfg.chainId);
    const byEscrow = new Map<Address, bigint[]>();
    for (const r of resolved) {
      if (!cachedOutcomes([r.id]).has(r.id.toString())) byEscrow.set(r.escrow, [...(byEscrow.get(r.escrow) ?? []), r.id]);
    }
    for (const [esc, missing] of byEscrow) scanSettled(client, esc, missing).then(merge).catch(() => {});
  }, [rows]);

  const [creating, setCreating] = useState(false);
  async function newFriendGame() {
    if (creating) return;
    setCreating(true);
    try {
      const session = createSessionKey();
      const id = await createAsync(session.address);
      persistSession(BigInt(id), session);
      recordAsyncMatch(id);
      window.location.href = `/play?async=${id}`;
    } catch (e) {
      setError(humanizeError(e)); // was a silent no-op — now the failure is visible
      setCreating(false);
    }
  }

  // Cancel an open money match nobody joined — the full stake comes back.
  const [cancelling, setCancelling] = useState<bigint | null>(null);
  async function cancelOpen(id: bigint, escrow: Address) {
    const cfg = escrowConfig();
    if (!cfg || !wallet || !account || cancelling !== null) return;
    setCancelling(id);
    try {
      await cancelMatch(wallet, { account, escrow, matchId: id, feeCurrency: FEE_CURRENCY });
      setRows((r) => (r ? r.filter((x) => x.id !== id) : r));
      setOpenMatches((o) => o.filter((x) => x.id !== id)); // it may be a chain-discovered row
    } catch (e) {
      setError(humanizeError(e));
    }
    setCancelling(null);
  }

  // Recovery for stuck money — the two situations where funds sit locked and
  // ONLY the player can free them (the contract gates voidExpired to players;
  // the server keeper cannot do it in their place):
  //  - a match that expired without finishing → reclaim both stakes in full
  //  - my own win, proposed and past its challenge window, that the keeper
  //    hasn't paid out yet → collect it now
  const [recovering, setRecovering] = useState<bigint | null>(null);
  async function reclaimStake(id: bigint, escrow: Address) {
    const cfg = escrowConfig();
    if (!cfg || !wallet || !account || recovering !== null) return;
    setRecovering(id);
    try {
      const h = await voidExpired(wallet, { account, escrow, matchId: id, feeCurrency: FEE_CURRENCY });
      await confirmTx(publicClient(cfg.rpcUrl, cfg.chainId), h, "Refund");
      setRows((r) => (r ? r.filter((x) => x.id !== id) : r));
    } catch (e) {
      setError(humanizeError(e));
    }
    setRecovering(null);
  }
  async function collectWin(id: bigint, escrow: Address) {
    const cfg = escrowConfig();
    if (!cfg || !wallet || !account || recovering !== null) return;
    setRecovering(id);
    try {
      const h = await finalizeResult(wallet, { account, escrow, matchId: id, feeCurrency: FEE_CURRENCY });
      await confirmTx(publicClient(cfg.rpcUrl, cfg.chainId), h, "Payout");
      setRows((r) => (r ? r.filter((x) => x.id !== id) : r));
    } catch (e) {
      setError(humanizeError(e));
    }
    setRecovering(null);
  }

  // Safety net: my open matches found by the CHAIN scan that the device's
  // local list doesn't know about (the pre-receipt id prediction could record
  // the wrong number) — surfaced so the stake is always visible & cancellable.
  const chainMine: Row[] = account
    ? openMatches
        .filter((o) => o.mine && !(rows ?? []).some((r) => r.id === o.id))
        .map((o) => ({
          id: o.id,
          escrow: escrowConfig()!.escrow, // lobby is always the current escrow
          status: 1,
          stake: o.stake,
          rakeBps: o.rakeBps,
          player0: o.creator,
          player1: "0x0000000000000000000000000000000000000000" as Address,
          activeDeadline: 0,
          challengeDeadline: 0,
          proposedWinner: 0,
        }))
    : [];
  const myRows = rows === null ? null : [...rows, ...chainMine];

  return (
    <main className="pad stack" style={{ flex: 1, gap: 12 }}>
      <span className="title">Your matches</span>

      {asyncEnabled() && (
        <button className="btn block" onClick={newFriendGame} disabled={creating}>
          <Icon name="versus" size={17} /> {creating ? "Creating…" : "Invite a friend — free game"}
        </button>
      )}

      {openMatches.some((o) => !o.mine) && (
        <>
          <span className="section-label">Money matches — open to join</span>
          {openMatches.some((o) => o.mine) && (
            <span className="faint" style={{ fontSize: 11.5 }}>
              This list is what YOU can join — your own open matches are under &ldquo;Your money matches&rdquo; below,
              so it differs from player to player.
            </span>
          )}
          {openMatches.filter((o) => !o.mine).map((o) => {
            const { prize } = computePayout(o.stake, o.rakeBps);
            return (
              <div className="list-row" key={o.id.toString()} style={{ cursor: "default" }}>
                <span className="lead gold">
                  <Icon name="bolt" size={18} />
                </span>
                <span className="col" style={{ flex: 1, gap: 1 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{friendlyName(o.creator)}</span>
                  <span className="faint">
                    Stake {fmt(o.stake, STAKE_DECIMALS)} · winner takes {fmt(prize, STAKE_DECIMALS)} {STAKE_SYMBOL}
                  </span>
                </span>
                <button className="btn secondary" style={{ padding: "8px 14px" }} onClick={() => joinOpen(o.id)} disabled={joining !== null}>
                  {joining === o.id ? "Joining…" : "Join"}
                </button>
              </div>
            );
          })}
        </>
      )}

      {asyncRows.length > 0 && (
        <>
          <span className="section-label">
            With a friend
            {asyncRows.some((r) => r.yourTurn) && (
              <span className="chip positive" style={{ marginLeft: 8 }}>
                {asyncRows.filter((r) => r.yourTurn).length} need your move
              </span>
            )}
          </span>
          {asyncRows.map((r) => (
            <Link className="list-row" key={r.id} href={`/play?async=${r.id}`}>
              <span className={`lead ${r.yourTurn ? "" : "neutral"}`}>
                <Icon name="versus" size={18} />
              </span>
              <span className="col" style={{ flex: 1, gap: 2 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{r.opponent}</span>
                <span className="faint">
                  {r.over ? "Finished" : r.open ? "Invite pending" : r.yourTurn ? "Your turn" : "Their turn"}
                </span>
              </span>
              {r.yourTurn && (
                <span className="chip positive" style={{ marginRight: 4 }}>
                  <span className="dot pulse" /> Play
                </span>
              )}
            </Link>
          ))}
        </>
      )}

      {myRows === null ? (
        <div className="card">
          <span className="chip">
            <span className="dot pulse" />
            Loading…
          </span>
        </div>
      ) : myRows.length === 0 && error ? (
        // a failed read is not "no matches" — say what happened, offer a retry
        <div className="card stack" style={{ gap: 10, alignItems: "center", textAlign: "center" }}>
          <span className="h2">Couldn&apos;t check your matches</span>
          <span className="muted">{error}</span>
          <button className="btn block" style={{ marginTop: 4 }} onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      ) : myRows.length === 0 ? (
        <div className="card stack" style={{ gap: 10, alignItems: "center", textAlign: "center" }}>
          <span className="lead" style={{ width: 52, height: 52, borderRadius: 16 }}>
            <Icon name="target" size={26} />
          </span>
          <span className="h2">No matches yet</span>
          <span className="muted">Create or join a match from the home screen and it will show up here.</span>
          <Link className="btn block" href="/" style={{ marginTop: 4 }}>
            Go to lobby
          </Link>
        </div>
      ) : (
        <>
          <span className="section-label">Your money matches</span>
          {myRows.map((r) => {
            const sv = statusView(r.status);
            const { prize } = computePayout(r.stake, r.rakeBps);
            const me = account?.toLowerCase();
            const mineOpen = r.status === 1 && me !== undefined && r.player0.toLowerCase() === me;
            const mySeat =
              me === undefined ? null : r.player0.toLowerCase() === me ? 0 : r.player1.toLowerCase() === me ? 1 : null;
            const now = Math.floor(Date.now() / 1000);
            // stuck money, and only THIS wallet can free it (contract rule)
            const expired =
              mySeat !== null && (r.status === 2 || r.status === 3) && r.activeDeadline > 0 && now > r.activeDeadline;
            const collectable = mySeat !== null && r.status === 3 && now > r.challengeDeadline && r.proposedWinner === mySeat;
            // finished-match outcome for THIS wallet (win/lose/draw + net)
            const oc = r.status === 4 ? outcomes[r.id.toString()] : undefined;
            const result =
              oc && mySeat !== null ? (oc.winner === 2 ? "draw" : oc.winner === mySeat ? "won" : "lost") : null;
            const resultChip =
              result === "won"
                ? { label: `You won +${fmt(oc!.prize - r.stake, STAKE_DECIMALS)} ${STAKE_SYMBOL}`, tone: "positive" }
                : result === "lost"
                  ? { label: `You lost ${fmt(r.stake, STAKE_DECIMALS)} ${STAKE_SYMBOL}`, tone: "danger" }
                  : result === "draw"
                    ? { label: "Draw — stake back", tone: "" }
                    : null;
            return (
              <div className="card stack animate-in" key={r.id.toString()} style={{ gap: 8 }}>
                <div className="row">
                  <span className="col" style={{ gap: 4 }}>
                    <span style={{ fontWeight: 700, fontSize: 14.5 }}>Match #{r.id.toString()}</span>
                    <span className="faint">
                      You each stake {fmt(r.stake, STAKE_DECIMALS)} · winner takes {fmt(prize, STAKE_DECIMALS)} {STAKE_SYMBOL}
                    </span>
                  </span>
                  <span className={`chip ${resultChip ? resultChip.tone : sv.tone}`}>
                    {sv.live && <span className="dot pulse" />}
                    {resultChip ? resultChip.label : sv.label}
                  </span>
                </div>
                {collectable && (
                  <>
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      You won this game — the payout is ready to collect.
                    </span>
                    <button className="btn block" onClick={() => collectWin(r.id, r.escrow)} disabled={recovering !== null}>
                      {recovering === r.id ? "Collecting…" : `Collect ${fmt(prize, STAKE_DECIMALS)} ${STAKE_SYMBOL}`}
                    </button>
                  </>
                )}
                {expired && !collectable && (
                  <>
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      This game never finished. Get your full stake back — no fee.
                    </span>
                    <button className="btn block" onClick={() => reclaimStake(r.id, r.escrow)} disabled={recovering !== null}>
                      {recovering === r.id ? "Refunding…" : "Get my stake back"}
                    </button>
                  </>
                )}
                {sv.live && !expired && !collectable && (
                  <div className="row" style={{ gap: 8 }}>
                    <Link className="btn secondary" href={`/play?match=${r.id.toString()}`} style={{ flex: 1, justifyContent: "center" }}>
                      {r.status === 1 ? "Open & invite" : "Resume"}
                    </Link>
                    {mineOpen && (
                      <button
                        className="btn ghost"
                        style={{ flex: 1, justifyContent: "center" }}
                        onClick={() => cancelOpen(r.id, r.escrow)}
                        disabled={cancelling !== null}
                      >
                        {cancelling === r.id ? "Cancelling…" : "Cancel & refund"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </main>
  );
}
