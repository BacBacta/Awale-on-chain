"use client";

// Compete — progression in one place. For a brand-new player the page has one
// job: explain the climb (Seedling → Grandmaster) and offer the first step.
// Only once they hold a real rank does it become a dashboard: rank card,
// weekly race, quests, ladder, and the door to the season.

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { getInjectedProvider, connect } from "../../src/lib/minipay.js";
import { escrowConfig } from "../../src/lib/escrow.js";
import { getProfile, rankFor, TIERS, type PlayerProfile } from "../../src/lib/profile.js";
import { streakCount } from "../../src/lib/daily.js";
import { DailyQuests } from "../../src/components/DailyQuests.js";
import { SkillLeaderboard } from "../../src/components/SkillLeaderboard.js";
import { WeeklyLeague } from "../../src/components/WeeklyLeague.js";
import { Icon, type IconName } from "../../src/components/Icon.js";
import { RankHero } from "../../src/components/RankHero.js";
import { harvestAddress, leagueComingSoon } from "../../src/lib/league.js";

function Row({ href, icon, title, sub, badge }: { href: string; icon: IconName; title: string; sub: string; badge?: string }) {
  return (
    <Link className="list-row" href={href}>
      <span className="lead gold">
        <Icon name={icon} size={19} />
      </span>
      <span className="col" style={{ flex: 1, gap: 1 }}>
        <span className="row" style={{ gap: 6, alignItems: "center" }}>
          <span style={{ fontWeight: 700, fontSize: 14.5 }}>{title}</span>
          {badge && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 0.4,
                padding: "2px 6px",
                borderRadius: 999,
                color: "var(--gold)",
                background: "rgba(201,162,74,0.14)",
              }}
            >
              {badge}
            </span>
          )}
        </span>
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

  const ranked = profile !== null && profile.gamesPlayed > 0;
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

      {ranked && rank && profile ? (
        // my rank — the reason to come back after a loss
        <RankHero elo={profile.elo} wins={profile.gamesWon} games={profile.gamesPlayed} perfectDays={profile.perfectDays ?? 0} />
      ) : (
        // new player — one card that explains the whole tab, one action
        <div className="card stack animate-in" style={{ gap: 14, padding: "18px 16px" }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            {TIERS.map((t, i) => (
              <span key={t.name} className="col" style={{ alignItems: "center", gap: 3, flex: 1 }}>
                <span style={{ fontSize: 20, opacity: i === 0 ? 1 : 0.55 }}>{t.icon}</span>
                <span className="faint" style={{ fontSize: 9.5, textAlign: "center" }}>
                  {t.name}
                </span>
              </span>
            ))}
          </div>
          <span className="muted" style={{ textAlign: "center" }}>
            Win matches to climb from Seedling to Grandmaster. Every match against another player counts — your first
            one places you on the ladder.
          </span>
          <Link className="btn block" href="/?play=1">
            Play your first game
          </Link>
        </div>
      )}

      {/* the weekly race — the recurring money event (replaced tournaments:
          a leaderboard works at any player count, a bracket doesn't) */}
      <WeeklyLeague />

      {/* today's quests */}
      {profile && <DailyQuests quests={profile.quests ?? []} perfectDays={profile.perfectDays ?? 0} />}

      {/* the ladder — renders only once someone is on it */}
      <SkillLeaderboard label="Ladder" />

      {/* the other arenas — each row names its game and its metric, so the
          three boards (rating / weekly pts / all-time money) never blur */}
      <span className="section-label">More ways to compete</span>
      <div className="stack" style={{ gap: 8 }}>
        <Row
          href="/stats"
          icon="medal"
          title="All-time winners"
          sub="The biggest net winners since launch — every settled money game counts"
        />
        {harvestAddress() && (
          <Row
            href="/league"
            icon="trophy"
            title="Season"
            badge={leagueComingSoon() ? "Soon" : undefined}
            sub={
              leagueComingSoon()
                ? "No-loss savings — launching shortly"
                : "No-loss savings — your deposit always comes back in full"
            }
          />
        )}
      </div>

      <div className="spacer" />

      <div className="row" style={{ justifyContent: "center", gap: 14, paddingBottom: 4 }}>
        <Link href="/guide#winning" className="faint" style={{ fontSize: 12.5 }}>
          How ranks, the race & the season work
        </Link>
      </div>
    </main>
  );
}
