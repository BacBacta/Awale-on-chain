"use client";

import { Icon } from "../../src/components/Icon.js";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { getInjectedProvider, connect } from "../../src/lib/minipay.js";
import { escrowConfig } from "../../src/lib/escrow.js";
import { friendlyName } from "../../src/lib/names.js";
import { shortAddress } from "../../src/lib/identity.js";
import {
  clubsEnabled,
  createClub,
  joinClub,
  myClubs,
  shareClub,
  startClubTournament,
  listClubTournaments,
  type Club,
} from "../../src/lib/clubs.js";
import { joinTournament, topPrize, type Tournament } from "../../src/lib/tournaments.js";
import { fmt } from "../../src/lib/money.js";
import type { WriteClient } from "../../src/lib/escrow.js";

const STAKE_TOKEN = (process.env.NEXT_PUBLIC_STAKE_TOKEN ?? "") as Address;
const STAKE_DECIMALS = Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "18");
const STAKE_SYMBOL = process.env.NEXT_PUBLIC_STAKE_SYMBOL ?? "USDC";
const FEE_CURRENCY = (process.env.NEXT_PUBLIC_FEE_CURRENCY || undefined) as Address | undefined;
const ONE_TOKEN = (10n ** BigInt(STAKE_DECIMALS)).toString(); // default club buy-in: 1 token

export default function Clubs() {
  const [account, setAccount] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<WriteClient | null>(null);
  const [clubs, setClubs] = useState<Club[] | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cfg = escrowConfig();
    const p = getInjectedProvider();
    if (!p) {
      setClubs([]);
      return;
    }
    connect(p, cfg?.chainId)
      .then(async ({ wallet, address }) => {
        setWallet(wallet as unknown as WriteClient);
        setAccount(address);
        setClubs(await myClubs(address));
      })
      .catch(() => setClubs([]));
  }, []);

  async function refresh(addr: Address) {
    setClubs(await myClubs(addr));
  }

  async function onCreate() {
    if (!account || !name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createClub(name.trim(), account);
      setName("");
      await refresh(account);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onJoin() {
    if (!account || !code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await joinClub(code.trim(), account);
      setCode("");
      await refresh(account);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="pad stack" style={{ flex: 1, gap: 14 }}>
      <div className="card row animate-in" style={{ gap: 13, padding: 16 }}>
        <span className="lead gold" style={{ width: 46, height: 46, borderRadius: 15 }}>
          <Icon name="versus" size={22} />
        </span>
        <span className="col" style={{ flex: 1, gap: 3 }}>
          <span className="h2">Clubs</span>
          <span className="muted" style={{ lineHeight: 1.35 }}>
            Your crew, one roster. Invite by code, play each other, run club games.
          </span>
        </span>
      </div>

      {!clubsEnabled() ? (
        <div className="card muted">Clubs need the game server — not configured on this build.</div>
      ) : !account ? (
        <div className="card muted">Open in MiniPay to create or join a club.</div>
      ) : (
        <>
          {/* your clubs */}
          {clubs === null ? (
            <div className="card">
              <span className="chip">
                <span className="dot pulse" /> Loading…
              </span>
            </div>
          ) : clubs.length > 0 ? (
            <>
              <span className="section-label">Your clubs</span>
              {clubs.map((c) => (
                <div className="card stack" key={c.id} style={{ gap: 10, padding: 14 }}>
                  <div className="row">
                    <span className="col" style={{ gap: 2 }}>
                      <span style={{ fontWeight: 700, fontSize: 15 }}>{c.name}</span>
                      <span className="faint">
                        {c.members.length} member{c.members.length > 1 ? "s" : ""} · code{" "}
                        <b style={{ color: "var(--text)", letterSpacing: "0.05em" }}>{c.code}</b>
                      </span>
                    </span>
                    <button className="btn secondary" style={{ padding: "8px 12px" }} onClick={() => shareClub(c)}>
                      <Icon name="share" size={15} /> Invite
                    </button>
                  </div>
                  <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                    {c.members.slice(0, 8).map((m) => (
                      <span key={m} className="chip" title={shortAddress(m)}>
                        {friendlyName(m)}
                      </span>
                    ))}
                  </div>
                  <ClubGames club={c} account={account} wallet={wallet} />
                </div>
              ))}
            </>
          ) : (
            <div className="card muted">No clubs yet — create one or join a friend&apos;s with their code.</div>
          )}

          {/* create */}
          <span className="section-label">Create a club</span>
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Club name"
              maxLength={40}
            />
            <button className="btn" style={{ padding: "12px 16px" }} onClick={onCreate} disabled={busy || !name.trim()}>
              Create
            </button>
          </div>

          {/* join */}
          <span className="section-label">Join with a code</span>
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABC123"
              maxLength={6}
              style={{ letterSpacing: "0.12em", fontWeight: 700 }}
            />
            <button className="btn secondary" style={{ padding: "12px 16px" }} onClick={onJoin} disabled={busy || !code.trim()}>
              Join
            </button>
          </div>

          {error && (
            <span className="chip danger" style={{ alignSelf: "flex-start" }}>
              {error}
            </span>
          )}
        </>
      )}

      <div className="spacer" />
      <Link className="btn ghost block" href="/">
        Back to Play
      </Link>
    </main>
  );
}

function ClubGames({ club, account, wallet }: { club: Club; account: Address | null; wallet: WriteClient | null }) {
  const [games, setGames] = useState<Tournament[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => listClubTournaments(club.id).then(setGames).catch(() => setGames([]));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [club.id]);

  async function start() {
    if (!account || busy || !STAKE_TOKEN) return;
    setBusy("start");
    try {
      await startClubTournament(club.id, STAKE_TOKEN, ONE_TOKEN, 8);
      await load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function join(t: Tournament) {
    const cfg = escrowConfig();
    if (!cfg || !wallet || !account || busy) return;
    setBusy(t.id);
    try {
      await joinTournament({ wallet, account, t, chainId: cfg.chainId, rpcUrl: cfg.rpcUrl, feeCurrency: FEE_CURRENCY });
      window.location.href = `/play?tournament=${t.id}`;
    } catch (e) {
      alert((e as Error).message);
      setBusy(null);
    }
  }

  const open = (games ?? []).filter((t) => t.phase === "lobby");

  return (
    <div className="stack" style={{ gap: 8, marginTop: 4 }}>
      <div className="row">
        <span className="section-label">Club games</span>
        <button className="btn secondary" style={{ padding: "6px 12px", fontSize: 13 }} onClick={start} disabled={!account || busy === "start"}>
          {busy === "start" ? "Starting…" : `Start a ${fmt(BigInt(ONE_TOKEN), STAKE_DECIMALS)} ${STAKE_SYMBOL} game`}
        </button>
      </div>
      {open.length === 0 ? (
        <span className="faint">No open club games — start one and invite the crew.</span>
      ) : (
        open.map((t) => (
          <div className="list-row" key={t.id} style={{ cursor: "default" }}>
            <span className="lead gold">
              <Icon name="trophy" size={17} />
            </span>
            <span className="col" style={{ flex: 1, gap: 1 }}>
              <span style={{ fontWeight: 700, fontSize: 13.5 }}>
                {fmt(BigInt(t.entryFee), STAKE_DECIMALS)} {STAKE_SYMBOL} · {t.entrants.length}/{t.maxPlayers}
              </span>
              <span className="faint">win up to {fmt(topPrize(t), STAKE_DECIMALS)} {STAKE_SYMBOL}</span>
            </span>
            <button className="btn" style={{ padding: "7px 12px" }} onClick={() => join(t)} disabled={!wallet || busy !== null}>
              {busy === t.id ? "Joining…" : "Join"}
            </button>
          </div>
        ))
      )}
    </div>
  );
}
