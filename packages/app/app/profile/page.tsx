"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { getInjectedProvider, connect } from "../../src/lib/minipay.js";
import { escrowConfig } from "../../src/lib/escrow.js";
import { friendlyName } from "../../src/lib/names.js";
import { shortAddress } from "../../src/lib/identity.js";
import { getEquipped, ALL_SKINS } from "../../src/lib/skins.js";
import { PlayerStats } from "../../src/components/PlayerStats.js";
import { Icon } from "../../src/components/Icon.js";
import { listOpponents } from "../../src/lib/social.js";
import { asyncEnabled, createAsync, recordAsyncMatch } from "../../src/lib/asyncClient.js";
import { createSessionKey, persistSession } from "../../src/lib/session.js";
import { getProfile, rankFor, type PlayerProfile } from "../../src/lib/profile.js";

function avatarGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 62% 52%), hsl(${(h + 40) % 360} 60% 38%))`;
}

export default function Profile() {
  const cfg = escrowConfig();
  const [address, setAddress] = useState<Address | null>(null);
  const [equipped, setEquipped] = useState(getEquipped());
  const [profile, setProfile] = useState<PlayerProfile | null>(null);

  useEffect(() => {
    setEquipped(getEquipped());
    const p = getInjectedProvider();
    if (p)
      connect(p, cfg?.chainId)
        .then(async ({ address }) => {
          setAddress(address);
          setProfile(await getProfile(address));
        })
        .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [opponents, setOpponents] = useState<Address[]>([]);
  const [challenging, setChallenging] = useState(false);
  useEffect(() => setOpponents(listOpponents()), []);

  async function challenge() {
    if (challenging) return;
    setChallenging(true);
    try {
      const s = createSessionKey();
      const id = await createAsync(s.address);
      persistSession(BigInt(id), s);
      recordAsyncMatch(id);
      window.location.href = `/play?async=${id}`;
    } catch {
      setChallenging(false);
    }
  }

  const name = friendlyName(address);
  const initial = name.trim()[0]?.toUpperCase() ?? "?";
  const boardSkin = ALL_SKINS.find((s) => s.asset === equipped.wood);
  const seedSkin = ALL_SKINS.find((s) => s.asset === equipped.seed);

  return (
    <main className="pad stack" style={{ flex: 1, gap: 16 }}>
      <span className="title">Profile</span>

      {/* identity */}
      <div className="card row animate-in" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 14 }}>
          <div
            aria-hidden
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              background: avatarGradient(name),
              display: "grid",
              placeItems: "center",
              fontWeight: 800,
              fontSize: 24,
              color: "#0b0f0a",
              boxShadow: "0 0 0 2px var(--accent)",
            }}
          >
            {initial}
          </div>
          <div className="col" style={{ gap: 2 }}>
            <span style={{ fontWeight: 750, fontSize: 18 }}>{name}</span>
            <span className="faint">{address ? shortAddress(address) : "Open in MiniPay"}</span>
          </div>
        </div>
      </div>

      {/* skill rank — the durable server-side rating (casual + async play) */}
      {profile && profile.gamesPlayed > 0 && (
        <div className="card row animate-in">
          <div className="col" style={{ gap: 4 }}>
            <span className="chip gold" style={{ alignSelf: "flex-start" }}>
              {rankFor(profile.elo).icon} {rankFor(profile.elo).name}
            </span>
            <span className="faint">
              {profile.gamesWon} wins · {profile.gamesPlayed} games
            </span>
          </div>
          <span className="title score" style={{ color: "var(--gold)" }}>
            {profile.elo}
          </span>
        </div>
      )}

      {/* record */}
      <span className="section-label">Record</span>
      <PlayerStats />

      {/* equipped skin */}
      <span className="section-label">Equipped</span>
      <Link className="list-row" href="/shop">
        <span
          className="lead"
          style={{
            width: 46,
            height: 46,
            borderRadius: 12,
            background: `url(${equipped.wood}) center/cover`,
            boxShadow: "inset 0 0 0 1px var(--line)",
          }}
        />
        <span className="col" style={{ flex: 1, gap: 1 }}>
          <span style={{ fontWeight: 700, fontSize: 14.5 }}>{boardSkin?.name ?? "Board"}</span>
          <span className="faint">Seeds · {seedSkin?.name ?? "Amber"}</span>
        </span>
        <img src={equipped.seed} alt="" width={28} height={28} style={{ marginRight: 6 }} />
        <Icon name="arrowRight" size={16} style={{ color: "var(--faint)" }} />
      </Link>

      {/* quick links */}
      <span className="section-label">Activity</span>
      <div className="stack" style={{ gap: 8 }}>
        <Link className="list-row" href="/matches">
          <span className="lead neutral">
            <Icon name="target" size={19} />
          </span>
          <span className="col" style={{ flex: 1, gap: 1 }}>
            <span style={{ fontWeight: 700, fontSize: 14.5 }}>Your matches</span>
            <span className="faint">Active & finished games</span>
          </span>
          <Icon name="arrowRight" size={16} style={{ color: "var(--faint)" }} />
        </Link>
      </div>

      {/* rivals — opponents you've faced */}
      {(opponents.length > 0 || asyncEnabled()) && (
        <>
          <span className="section-label">Rivals</span>
          {opponents.length === 0 ? (
            <span className="faint">Play someone to start a rivalry.</span>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {opponents.slice(0, 6).map((addr) => (
                <div className="list-row" key={addr} style={{ cursor: "default" }}>
                  <span className="lead neutral">
                    <Icon name="versus" size={18} />
                  </span>
                  <span className="col" style={{ flex: 1, gap: 1 }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{friendlyName(addr)}</span>
                    <span className="faint">{shortAddress(addr)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
          {asyncEnabled() && (
            <button className="btn secondary block" onClick={challenge} disabled={challenging}>
              <Icon name="versus" size={16} /> {challenging ? "Creating…" : "Challenge a friend"}
            </button>
          )}
        </>
      )}

      <div className="spacer" />
    </main>
  );
}
