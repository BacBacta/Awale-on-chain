"use client";

import { Icon } from "../../src/components/Icon.js";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { getInjectedProvider, connect } from "../../src/lib/minipay.js";
import { escrowConfig } from "../../src/lib/escrow.js";
import { friendlyName } from "../../src/lib/names.js";
import { shortAddress } from "../../src/lib/identity.js";
import { clubsEnabled, createClub, joinClub, myClubs, shareClub, type Club } from "../../src/lib/clubs.js";

export default function Clubs() {
  const [account, setAccount] = useState<Address | null>(null);
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
      .then(async ({ address }) => {
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
