// Weekly prize-pool league — the recurring money event, replacing bracket
// tournaments (which need N players online at once; a leaderboard works at any
// concurrency). Every on-chain-settled staked game counts automatically:
// 3 points a win, 1 a draw, only the first few games against the same opponent
// score (anti-farming), and a minimum games-played bar keeps one lucky win from
// sniping the pool. A share of the week's rake funds the pot; Monday 00:00 UTC
// everything resets and the previous week's top players are paid out.
//
// The chain is the source of truth for what counts: entries are credited from
// MatchEscrow's MatchSettled event (see main.ts), never from a server-side
// opinion of who won — consistent with "the server never decides stakes".

import type { Address } from "viem";
import type { RedisLike } from "./persistence/redis-store.js";

export interface LeagueEntry {
  address: Address;
  /** 3 per win (draws score 0) — only within the per-opponent cap. */
  points: number;
  /** Every counted staked game (eligibility bar), capped or not. */
  games: number;
  wins: number;
  /** Games played vs each opponent this week; past the cap they stop scoring. */
  perOpp: Record<string, number>;
  /** Referral bonuses granted this week (capped — see addReferralBonus). */
  refBonuses?: number;
}

export interface LeagueWeek {
  /** The week's Monday, UTC, as YYYY-MM-DD — the storage key. */
  week: string;
  /** Prize pot in token wei (bigint as string — JSON-safe). */
  poolWei: string;
  /** Stake token of the games seen this week (single-token deployment). */
  token: Address | null;
  entries: Record<string, LeagueEntry>;
}

export interface LeagueWinner {
  address: Address;
  amountWei: string;
}

export interface LeagueHistoryEntry {
  week: string;
  poolWei: string;
  token: Address | null;
  winners: LeagueWinner[];
}

export interface LeagueStanding {
  address: Address;
  points: number;
  games: number;
  wins: number;
}

export const WIN_POINTS = 3;
/** A draw refunds both stakes on-chain — no rake is ever paid. Scoring it
 *  would hand out league points for free (two colluding wallets signing
 *  agreed draws at gas-only cost), so a draw counts for eligibility but
 *  earns nothing. */
export const DRAW_POINTS = 0;
/** @deprecated old top-5 schedule — kept only for historical reference. */
export const PAYOUT_BPS = [5000, 2500, 1500, 700, 300];

/** Podium BONUS for ranks 1-3, on top of the shared dividend. Deliberately
 *  small (10% of the pot in total): the pot belongs to everyone who raced. */
export const PODIUM_BPS = [500, 300, 200];
/** The bulk of the pool is a DIVIDEND shared by EVERY eligible player,
 *  pro-rata to points — naturally degressive down the table, and nobody who
 *  put in the games walks away with nothing. It must include the podium:
 *  with a small podium and a ranks-4+-only dividend, #4 could out-earn #1
 *  (an inversion that rewards LOSING rank). Bonus + monotone dividend keeps
 *  rank order and payout order aligned. */
export const DIVIDEND_BPS = 9000;

/** Split `pool` across the standings: a 90% dividend pro-rata to points
 *  over ALL ranked players, plus the podium bonus for ranks 1-3. Pure.
 *  Whatever can't be assigned (nobody ranked, zero total points, rounding
 *  dust) isn't emitted — the caller carries the difference forward. */
export function computePrizes(ranked: LeagueStanding[], pool: bigint): LeagueWinner[] {
  const out: LeagueWinner[] = [];
  const totalPts = ranked.reduce((a, s) => a + s.points, 0);
  const dividend = (pool * BigInt(DIVIDEND_BPS)) / 10_000n;
  ranked.forEach((s, i) => {
    let amt = i < PODIUM_BPS.length ? (pool * BigInt(PODIUM_BPS[i])) / 10_000n : 0n;
    if (totalPts > 0) amt += (dividend * BigInt(s.points)) / BigInt(totalPts);
    if (amt > 0n) out.push({ address: s.address, amountWei: amt.toString() });
  });
  return out;
}

const DEFAULT_MIN_GAMES = 5;
const DEFAULT_PAIR_CAP = 3;
/** 45% of the rake feeds the pool by default — 55% stays with the platform. */
const DEFAULT_POOL_SHARE_BPS = 4500;

/** Monday 00:00 UTC of the week containing `now`, as YYYY-MM-DD. */
export function weekKey(now = new Date()): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Epoch ms of the following Monday 00:00 UTC — when this week's race ends. */
export function weekEndMs(week: string): number {
  return Date.parse(`${week}T00:00:00Z`) + 7 * 86_400_000;
}

export interface LeagueStore {
  load(week: string): Promise<LeagueWeek | null>;
  save(w: LeagueWeek): Promise<void>;
  /** The week currently accumulating — finalized (paid) when it falls behind. */
  openWeek(): Promise<string | null>;
  setOpenWeek(week: string): Promise<void>;
  lastResult(): Promise<LeagueHistoryEntry | null>;
  pushResult(h: LeagueHistoryEntry): Promise<void>;
}

export class InMemoryLeagueStore implements LeagueStore {
  private weeks = new Map<string, LeagueWeek>();
  private open: string | null = null;
  private last: LeagueHistoryEntry | null = null;
  async load(week: string) {
    return this.weeks.get(week) ?? null;
  }
  async save(w: LeagueWeek) {
    this.weeks.set(w.week, w);
  }
  async openWeek() {
    return this.open;
  }
  async setOpenWeek(week: string) {
    this.open = week;
  }
  async lastResult() {
    return this.last;
  }
  async pushResult(h: LeagueHistoryEntry) {
    this.last = h;
  }
}

const wkKey = (week: string) => `awale:wleague:${week}`;
const OPEN_KEY = "awale:wleague:open";
const LAST_KEY = "awale:wleague:last";

export class RedisLeagueStore implements LeagueStore {
  constructor(private readonly redis: RedisLike) {}
  async load(week: string): Promise<LeagueWeek | null> {
    const raw = await this.redis.get(wkKey(week));
    return raw ? (JSON.parse(raw) as LeagueWeek) : null;
  }
  async save(w: LeagueWeek): Promise<void> {
    await this.redis.set(wkKey(w.week), JSON.stringify(w));
  }
  async openWeek(): Promise<string | null> {
    return this.redis.get(OPEN_KEY);
  }
  async setOpenWeek(week: string): Promise<void> {
    await this.redis.set(OPEN_KEY, week);
  }
  async lastResult(): Promise<LeagueHistoryEntry | null> {
    const raw = await this.redis.get(LAST_KEY);
    return raw ? (JSON.parse(raw) as LeagueHistoryEntry) : null;
  }
  async pushResult(h: LeagueHistoryEntry): Promise<void> {
    await this.redis.set(LAST_KEY, JSON.stringify(h));
  }
}

export interface LeagueOptions {
  /** Games needed this week to appear in the standings (default 5). */
  minGames?: number;
  /** Scoring games per opponent pair per week (default 3). */
  pairCap?: number;
  /** Share of the rake that feeds the pool, in bps (default 5000 = half). */
  poolShareBps?: number;
  /** Ceiling on the pool carried into a new week (0 = no cap). A pot that
   *  compounds unpaid week over week eventually makes sybil-sniping +EV;
   *  until verified-payout is on, the carry is what needs the brake. */
  maxCarryWei?: bigint;
  /** Referral bonuses a player can earn per week (default 5). */
  refBonusCap?: number;
}

export class WeeklyLeague {
  readonly minGames: number;
  readonly pairCap: number;
  readonly poolShareBps: number;
  readonly maxCarryWei: bigint;
  readonly refBonusCap: number;

  constructor(
    private readonly store: LeagueStore,
    opts: LeagueOptions = {},
  ) {
    this.minGames = opts.minGames ?? DEFAULT_MIN_GAMES;
    this.pairCap = opts.pairCap ?? DEFAULT_PAIR_CAP;
    this.poolShareBps = opts.poolShareBps ?? DEFAULT_POOL_SHARE_BPS;
    this.maxCarryWei = opts.maxCarryWei ?? 0n;
    this.refBonusCap = opts.refBonusCap ?? 5;
  }

  private async loadOrCreate(week: string): Promise<LeagueWeek> {
    return (await this.store.load(week)) ?? { week, poolWei: "0", token: null, entries: {} };
  }

  /**
   * Credit one on-chain-settled staked game to the current week. `winner` uses
   * the escrow/engine convention (0, 1, 2 = draw); `potWei` is both stakes,
   * `rakeBps` the match's snapshotted rake. Draws refund without rake on-chain,
   * so they add points but nothing to the pool.
   */
  async recordGame(
    players: [Address, Address],
    winner: number,
    potWei: bigint,
    rakeBps: number,
    token: Address,
    now = new Date(),
  ): Promise<void> {
    const w = await this.loadOrCreate(weekKey(now));
    const keys = [players[0].toLowerCase(), players[1].toLowerCase()];
    if (keys[0] === keys[1]) return; // self-play settles on-chain but never scores

    for (const side of [0, 1] as const) {
      const me = keys[side];
      const opp = keys[1 - side];
      const e: LeagueEntry = w.entries[me] ?? { address: me as Address, points: 0, games: 0, wins: 0, perOpp: {} };
      e.games += 1;
      if (winner === side) e.wins += 1;
      const vsOpp = e.perOpp[opp] ?? 0;
      e.perOpp[opp] = vsOpp + 1;
      if (vsOpp < this.pairCap) e.points += winner === side ? WIN_POINTS : winner === 2 ? DRAW_POINTS : 0;
      w.entries[me] = e;
    }

    if (winner !== 2) {
      const contribution = (potWei * BigInt(rakeBps) * BigInt(this.poolShareBps)) / 100_000_000n;
      w.poolWei = (BigInt(w.poolWei) + contribution).toString();
    }
    if (!w.token) w.token = token;
    await this.store.save(w);
  }

  /**
   * Award referral league points to `referrer` — called when a referred friend
   * settles their FIRST cash game (so the bonus is always backed by real rake
   * the friend paid; a sybil "friend" costs the farmer more than the points
   * are worth). Capped per referrer per week. Returns false when capped.
   */
  async addReferralBonus(referrer: Address, points: number, now = new Date()): Promise<boolean> {
    const w = await this.loadOrCreate(weekKey(now));
    const key = referrer.toLowerCase();
    const e: LeagueEntry = w.entries[key] ?? { address: key as Address, points: 0, games: 0, wins: 0, perOpp: {} };
    if ((e.refBonuses ?? 0) >= this.refBonusCap) return false;
    e.refBonuses = (e.refBonuses ?? 0) + 1;
    e.points += points;
    w.entries[key] = e;
    await this.store.save(w);
    return true;
  }

  /** Eligible players (>= minGames), best first. */
  standings(w: LeagueWeek): LeagueStanding[] {
    return Object.values(w.entries)
      .filter((e) => e.games >= this.minGames)
      .sort(
        (a, b) =>
          b.points - a.points || b.wins - a.wins || a.games - b.games || a.address.localeCompare(b.address),
      )
      .map(({ address, points, games, wins }) => ({ address, points, games, wins }));
  }

  /** The current week as the client sees it, plus `me` if an address is given. */
  async snapshot(me?: Address, now = new Date()) {
    const week = weekKey(now);
    const w = await this.loadOrCreate(week);
    const standings = this.standings(w);
    const mine = me ? w.entries[me.toLowerCase()] : undefined;
    return {
      week,
      endsAt: weekEndMs(week),
      poolWei: w.poolWei,
      token: w.token,
      minGames: this.minGames,
      pairCap: this.pairCap,
      standings: standings.slice(0, 10),
      players: standings.length,
      me: mine
        ? {
            rank: standings.findIndex((s) => s.address === mine.address) + 1 || null,
            points: mine.points,
            games: mine.games,
            wins: mine.wins,
          }
        : null,
      lastWeek: await this.store.lastResult(),
    };
  }

  /**
   * Close out the previous week if the calendar has moved on: split the pool
   * across the top of the standings per PAYOUT_BPS, pay via the injected
   * callback (which returns the winners it actually managed to pay), and carry
   * everything unpaid into the new week so no funds are ever dropped. Returns
   * the history entry when a week was finalized, null otherwise. Safe to call
   * on every tick.
   */
  async rollover(
    payout: (token: Address, winners: LeagueWinner[]) => Promise<LeagueWinner[]>,
    now = new Date(),
  ): Promise<LeagueHistoryEntry | null> {
    const current = weekKey(now);
    const open = await this.store.openWeek();
    if (open === current) return null;
    if (open === null) {
      // first boot: adopt the current week, nothing to pay yet
      await this.store.setOpenWeek(current);
      return null;
    }

    const w = await this.loadOrCreate(open);
    const pool = BigInt(w.poolWei);
    const ranked = this.standings(w);
    // podium (40/20/10) + points-proportional dividend for everyone else
    const due: LeagueWinner[] = computePrizes(ranked, pool);

    const paid = due.length > 0 && w.token ? await payout(w.token, due) : [];
    const paidTotal = paid.reduce((a, c) => a + BigInt(c.amountWei), 0n);

    // whatever wasn't paid out (no eligible players, unpaid shares, failed
    // transfers) seeds next week's pool — clipped to maxCarryWei when set,
    // so an unclaimed pot can't compound into a sybil-worthy prize
    let carry = pool - paidTotal;
    if (this.maxCarryWei > 0n && carry > this.maxCarryWei) carry = this.maxCarryWei;
    if (carry > 0n || w.token) {
      const next = await this.loadOrCreate(current);
      next.poolWei = (BigInt(next.poolWei) + carry).toString();
      if (!next.token) next.token = w.token;
      await this.store.save(next);
    }

    const entry: LeagueHistoryEntry = { week: open, poolWei: w.poolWei, token: w.token, winners: paid };
    await this.store.pushResult(entry);
    await this.store.setOpenWeek(current);
    return entry;
  }
}
