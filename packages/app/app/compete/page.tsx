"use client";

// Compete — every form of progression in one place: your rank, today's
// quests, the streak, the skill ladder, and the doors to tournaments and the
// season. This is the tab the trophy icon leads to; the ranked ladder is no
// longer buried under "Stats".

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { getInjectedProvider, connect } from "../../src/lib/minipay.js";
import { escrowConfig } from "../../src/lib/escrow.js";
import { getProfile, rankFor, type PlayerProfile } from "../../src/lib/profile.js";
import { streakCount } from "../../src/lib/daily.js";
import { DailyQuests } from "../../src/components/DailyQuests.js";
import { SkillLeaderboard } from "../../src/components/SkillLeaderboard.js";
import { Icon, type IconName } from "../../src/components/Icon.js";
import { tournamentsEnabled } from "../../src/lib/tournaments.js";
import { harvestAddress } from "../../src/lib/league.js";

function Row({ href, icon, title, sub }: { href: string; icon: IconName; title: string; sub: string }) {
  return (
    <Link className="list-row" href={href}>
      <span className="lead gold">
        <Icon name={icon} size={19} />
      </span>
      <span className="col" style={{ flex: 1, gap: 1 }}>
        <span style={{ fontWeight: 700, fontSize: 14.5 }}>{title}</span>
        <span className="faint">{sub}</span>
      </span>
      <Icon name="arrowRight" size={16} style={{ color: "var(--faint)" }} />
    </Link>
  );
}

export default function Compete() {
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [streak, setStreak] = useState(0);

  useEffect(() => {
    setStreak(streakCount());
    const p = getInjectedProvider();
    if (!p) return;
    connect(p, escrowConfig()?.chainId)
      .then(async ({ address }) => {
        const prof = await getProfile(address as Address);
        setProfile(prof);
        if (prof && prof.streak > 0) setStreak((s) => Math.max(s, prof.streak));
      })
      .catch(() => {});
  }, []);

  const rank = profile ? rankFor(profile.elo) : null;

  return (
    <main className="pad stack" style={{ flex: 1, gap: 14 }}>
      <div className="row">
        <span className="title">Compete</span>
        {streak > 0 && (
          <Link href="/daily" className="chip gold" style={{ textDecoration: "none" }}>
            🔥 {streak}-day streak
          </Link>
        )}
      </div>

      {/* my rank — only once it's real. Showing "Sower · 1200" to someone who
          has never played is fake progression next to an empty ladder. */}
      {profile && rank && profile.gamesPlayed > 0 && (
        <div className="card row animate-in">
          <div className="col" style={{ gap: 4 }}>
            <span className="chip gold" style={{ alignSelf: "flex-start" }}>
              {rank.icon} {rank.name}
            </span>
            <span className="faint">
              {profile.gamesWon} wins · {profile.gamesPlayed} games
              {(profile.perfectDays ?? 0) > 0 ? ` · ✨ ${profile.perfectDays} perfect day${profile.perfectDays > 1 ? "s" : ""}` : ""}
            </span>
          </div>
          <span className="title score" style={{ color: "var(--gold)" }}>
            {profile.elo}
          </span>
        </div>
      )}

      {/* today's quests */}
      {profile && <DailyQuests quests={profile.quests ?? []} perfectDays={profile.perfectDays ?? 0} />}

      {/* the ladder */}
      <span className="section-label">Ranked ladder</span>
      <SkillLeaderboard />

      {/* doors to the bigger arenas */}
      <span className="section-label">Events</span>
      <div className="stack" style={{ gap: 8 }}>
        {tournamentsEnabled() && (
          <Row href="/tournaments" icon="medal" title="Tournaments" sub="One entry fee, a bracket, winner takes the pool" />
        )}
        {harvestAddress() && (
          <Row href="/league" icon="trophy" title="Season" sub="Deposit for the season — top of the ladder shares the prize" />
        )}
        <Row href="/stats" icon="chart" title="Money leaderboard & stats" sub="Biggest winners, global numbers" />
      </div>

      <div className="spacer" />
    </main>
  );
}
