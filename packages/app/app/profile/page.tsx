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
import { addCashDeeplink } from "../../src/lib/deeplinks.js";

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

  function shareReferral() {
    if (!address) return;
    const url = `${window.location.origin}/?ref=${address}`;
    const data = { title: "Awalé", text: "Play Awalé with me — win real money on MiniPay", url };
    if (navigator.share) navigator.share(data).catch(() => {});
    else navigator.clipboard?.writeText(url).catch(() => {});
  }

  const name = friendlyName(address);
  const initial = name.trim()[0]?.toUpperCase() ?? "?";
  const boardSkin = ALL_SKINS.find((s) => s.asset === equipped.wood);
  const seedSkin = ALL_SKINS.find((s) => s.asset === equipped.seed);

  const rank = profile ? rankFor(profile.elo) : null;
  const ranked = !!profile && profile.gamesPlayed > 0;

  return (
    <main className="pad stack" style={{ flex: 1, gap: 14 }}>
      <span className="title">Profile</span>

      {/* HERO — identity + rank in ONE premium card (no more duplicated rank) */}
      <div className="card animate-in" style={{ padding: 0, overflow: "hidden", gap: 0 }}>
        <div className="row" style={{ gap: 14, alignItems: "center", padding: 18 }}>
          <div
            aria-hidden
            style={{
              width: 58,
              height: 58,
              borderRadius: "50%",
              background: avatarGradient(name),
              display: "grid",
              placeItems: "center",
              fontWeight: 800,
              fontSize: 25,
              color: "#0b0f0a",
              boxShadow: "0 0 0 2px var(--accent), 0 8px 24px rgba(61,220,111,0.18)",
            }}
          >
            {initial}
          </div>
          <div className="col" style={{ flex: 1, gap: 3, minWidth: 0 }}>
            <span style={{ fontWeight: 750, fontSize: 19, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {name}
            </span>
            <span className="faint">{address ? shortAddress(address) : "Open in MiniPay"}</span>
          </div>
          {ranked && (
            <div className="col" style={{ alignItems: "flex-end", gap: 0 }}>
              <span className="title score" style={{ color: "var(--gold)", lineHeight: 1 }}>
                {profile!.elo}
              </span>
              <span className="faint" style={{ fontSize: 10.5, letterSpacing: 0.4, textTransform: "uppercase" }}>
                rating
              </span>
            </div>
          )}
        </div>
        {ranked && rank && (
          <div
            className="row"
            style={{
              gap: 10,
              alignItems: "center",
              padding: "12px 18px",
              borderTop: "1px solid var(--line)",
              background: "rgba(255,255,255,0.02)",
            }}
          >
            <span className="chip gold" style={{ flexShrink: 0 }}>
              {rank.icon} {rank.name}
            </span>
            <span className="faint" style={{ fontSize: 12.5 }}>
              {profile!.gamesWon} wins · {profile!.gamesPlayed} games
              {(profile!.perfectDays ?? 0) > 0 ? ` · ✨ ${profile!.perfectDays}` : ""}
            </span>
          </div>
        )}
      </div>

      {/* record — the numbers (rank lives in the hero above, so hide it here) */}
      <PlayerStats hideRank />

      {/* one clean actions block — money + activity together, no section clutter */}
      <div className="stack" style={{ gap: 8 }}>
        <a className="list-row" href={addCashDeeplink()}>
          <span className="lead gold">
            <Icon name="wallet" size={19} />
          </span>
          <span className="col" style={{ flex: 1, gap: 1 }}>
            <span style={{ fontWeight: 700, fontSize: 14.5 }}>Add money</span>
            <span className="faint">Top up your MiniPay balance</span>
          </span>
          <Icon name="arrowRight" size={16} style={{ color: "var(--faint)" }} />
        </a>
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
        <Link className="list-row" href="/stats">
          <span className="lead neutral">
            <Icon name="chart" size={19} />
          </span>
          <span className="col" style={{ flex: 1, gap: 1 }}>
            <span style={{ fontWeight: 700, fontSize: 14.5 }}>Stats & leaderboard</span>
            <span className="faint">Your record & the money ladder</span>
          </span>
          <Icon name="arrowRight" size={16} style={{ color: "var(--faint)" }} />
        </Link>
        <Link className="list-row" href="/shop">
          <span
            className="lead"
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: `url(${equipped.wood}) center/cover`,
              boxShadow: "inset 0 0 0 1px var(--line)",
            }}
          />
          <span className="col" style={{ flex: 1, gap: 1 }}>
            <span style={{ fontWeight: 700, fontSize: 14.5 }}>{boardSkin?.name ?? "Board"} skin</span>
            <span className="faint">Seeds · {seedSkin?.name ?? "Amber"} — tap to change</span>
          </span>
          <Icon name="arrowRight" size={16} style={{ color: "var(--faint)" }} />
        </Link>
      </div>

      {/* rivals — only when there are any, kept tight */}
      {opponents.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <span className="section-label">Rivals</span>
          {opponents.slice(0, 4).map((addr) => (
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

      {/* social actions grouped */}
      <div className="stack" style={{ gap: 8, marginTop: 2 }}>
        {asyncEnabled() && (
          <button className="btn secondary block" onClick={challenge} disabled={challenging}>
            <Icon name="versus" size={16} /> {challenging ? "Creating…" : "Challenge a friend"}
          </button>
        )}
        {address && (
          <button className="btn secondary block" onClick={shareReferral}>
            <Icon name="share" size={16} /> Invite friends — earn league points
          </button>
        )}
      </div>

      <div className="spacer" />
    </main>
  );
}
