"use client";

// The ONE place the whole system is explained — the canonical guide every
// other screen links to instead of re-explaining its own fragment in its own
// words. A first-time player read this top to bottom in a minute and knows:
// what the game is, the five ways to play it, what money games actually do,
// what winning earns, and why their money is safe. Vocabulary here is the
// vocabulary everywhere (Quick match / With a friend / For money / Weekly
// league / Season / Rank) — if a screen disagrees with this page, the screen
// is wrong.

import Link from "next/link";
import { Icon, type IconName } from "../../src/components/Icon.js";
import { TIERS as RANK_TIERS } from "../../src/lib/profile.js";
import { WINNER_PCT, FEE_PCT } from "../../src/lib/money.js";

// the ladder string, built from the single source so it never drifts
const TIERS = RANK_TIERS.map((t) => `${t.icon} ${t.name}`).join(" → ");

function Way({ icon, title, sub }: { icon: IconName; title: string; sub: string }) {
  return (
    <div className="list-row" style={{ cursor: "default" }}>
      <span className="lead neutral">
        <Icon name={icon} size={18} />
      </span>
      <span className="col" style={{ flex: 1, gap: 1 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{title}</span>
        <span className="faint">{sub}</span>
      </span>
    </div>
  );
}

function Point({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <span className="row" style={{ gap: 10, alignItems: "flex-start" }}>
      <span className="chip gold" style={{ minWidth: 22, justifyContent: "center", padding: "2px 0" }}>
        {n}
      </span>
      <span className="muted" style={{ flex: 1, lineHeight: 1.45 }}>
        {children}
      </span>
    </span>
  );
}

export default function Guide() {
  return (
    <main className="pad stack" style={{ flex: 1, gap: 14 }}>
      <span className="title">How it all works</span>
      <span className="muted">
        One game — Awalé. Play it free or for money. Every match against another player moves your rating.
      </span>

      {/* the game itself */}
      <span className="section-label" id="game" style={{ scrollMarginTop: 16 }}>
        The game
      </span>
      <div className="card stack" style={{ gap: 10 }}>
        <span className="muted" style={{ lineHeight: 1.5 }}>
          Sow seeds counter-clockwise around the board. When your last seed lands in an opponent&apos;s house and
          brings it to 2 or 3 seeds, you capture them. Most seeds at the end wins.
        </span>
        <Link className="btn secondary block" href="/learn">
          Learn by playing — takes 30 seconds
        </Link>
      </div>

      {/* how a game ends — including the anti-stall rule, in plain words */}
      <span className="section-label" id="ending" style={{ scrollMarginTop: 16 }}>
        How a game ends
      </span>
      <div className="card stack" style={{ gap: 10 }}>
        <span className="muted" style={{ lineHeight: 1.5 }}>
          Grab more than half the seeds — 25 of the 48 — and the game is yours. It can also end when a side has
          no seeds left to play.
        </span>
        <span className="muted" style={{ lineHeight: 1.5 }}>
          And if the board just keeps repeating — the same position coming back again and again, with no captures,
          often a trailing player shuffling seeds to avoid a loss — the game is settled where it stands: each side
          keeps the seeds on its own row, and whoever has more wins. You&apos;ll see a{" "}
          <span style={{ color: "var(--gold)" }}>repeating position</span> warning one move before this happens, so
          no one can drag a decided game out forever.
        </span>
      </div>

      {/* the five ways to play — same names as the home screen doors */}
      <span className="section-label" id="play" style={{ scrollMarginTop: 16 }}>
        Ways to play
      </span>
      <div className="stack" style={{ gap: 8 }}>
        <Way icon="bolt" title="Quick match" sub="Free · live vs a real player · no clock" />
        <Way icon="versus" title="With a friend" sub="Free · share a link · play at your own pace" />
        <Way icon="wallet" title="For money" sub={`You each stake $0.25–1 · winner takes ${WINNER_PCT}`} />
        <Way icon="play" title="Practice vs AI" sub="Free · warm up anytime · pick your level" />
        <Way icon="target" title="Daily puzzle" sub="Free · one a day · keeps your streak alive" />
      </div>

      {/* money, spelled out once */}
      <span className="section-label" id="money" style={{ scrollMarginTop: 16 }}>
        When money&apos;s on the line
      </span>
      <div className="card stack" style={{ gap: 10 }}>
        <Point n={1}>You and your opponent each put the same amount in the pot.</Point>
        <Point n={2}>The winner takes {WINNER_PCT} of the pot. The {FEE_PCT} house fee is always shown before you stake.</Point>
        <Point n={3}>A draw refunds both players in full — no fee taken.</Point>
        <Point n={4}>Nobody joined your match yet? Cancel anytime — your stake comes back in full.</Point>
        <Point n={5}>Stakes are held by a smart contract on Celo until the game settles — not by us.</Point>
      </div>

      {/* what winning earns */}
      <span className="section-label" id="winning" style={{ scrollMarginTop: 16 }}>
        What winning earns you
      </span>
      <div className="card stack" style={{ gap: 10 }}>
        <span className="muted" style={{ lineHeight: 1.5 }}>
          <b style={{ color: "var(--text)" }}>Your rating &amp; rank.</b> Every match against another player — free or
          for money — moves your <b style={{ color: "var(--text)" }}>rating</b> (the number). It earns a{" "}
          <b style={{ color: "var(--text)" }}>rank</b> (the badge). Practice and the daily puzzle are just for fun.
          <br />
          <span style={{ fontSize: 13 }}>{TIERS}</span>
        </span>
        <span className="muted" style={{ lineHeight: 1.5 }}>
          <b style={{ color: "var(--text)" }}>The Weekly race.</b> The recurring money event — it resets every Monday.
          Money games score points automatically: a win is 3 points, draws score nothing, and only your first 3 games
          against the same opponent count. Play 5 money games in a week and you&apos;re in. On Monday the pot splits in
          proportion to points — more points, bigger share — and the top 3 add a small podium bonus. Winners collect
          with one tap in Compete. 45% of every house fee feeds that pot, so the fee partly comes back to the players.
        </span>
        <span className="muted" style={{ lineHeight: 1.5 }}>
          <b style={{ color: "var(--text)" }}>All-time winners.</b> The money hall of fame: net winnings across every
          settled money game since day one. It never resets — find it under Stats.
        </span>
        <span className="faint" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          In short — three boards, three different games: the <b>Ladder</b> ranks skill (rating, all-time), the{" "}
          <b>Weekly race</b> pays points (pot splits Monday), and <b>All-time winners</b> counts money (never resets).
        </span>
      </div>

      {/* season — optional layer */}
      <span className="section-label" id="season" style={{ scrollMarginTop: 16 }}>
        The season (optional)
      </span>
      <div className="card stack" style={{ gap: 8 }}>
        <span className="muted" style={{ lineHeight: 1.5 }}>
          No-loss savings, separate from the boards above. When deposits open, put money in for the season — it always
          comes back in full at the end. While it&apos;s deposited it earns yield, and that yield is shared by the
          depositors who win the most money games. You can only win.
        </span>
      </div>

      {/* trust */}
      <span className="section-label" id="safety" style={{ scrollMarginTop: 16 }}>
        Fair &amp; safe
      </span>
      <div className="card stack" style={{ gap: 10 }}>
        <Point n={1}>18+ only. Stake what you can afford to lose — nothing more.</Point>
        <Point n={2}>
          Take your time: Quick match has no clock. Only money games are timed — 25 seconds per move (miss it and you forfeit; the app never plays for you). Friend games allow days per move. If an
          opponent abandons a money game, you claim the win.
        </Point>
        <Point n={3}>Every fee and payout is shown before you commit. No hidden costs.</Point>
      </div>

      <Link className="btn block" href="/?play=1" style={{ marginTop: 4 }}>
        <Icon name="play" size={17} /> Play a free game
      </Link>

      <div className="spacer" />
    </main>
  );
}
