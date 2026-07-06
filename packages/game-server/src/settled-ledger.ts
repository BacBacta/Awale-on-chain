// Durable ledger of on-chain-settled matches — the single dedup gate for
// everything MatchSettled feeds (weekly league, money leaderboard, player
// profiles). Two problems it solves:
//
//   1. Exactly-once crediting across restarts: the in-process `Set` the
//      watcher used before was empty after every deploy, so a backfill would
//      have re-counted games. Counted ids persist here instead.
//   2. Deploy-gap blindness: events emitted while the server was down were
//      simply lost. The ledger remembers the last block it processed so boot
//      can backfill the gap (see backfillSettled in main.ts).
//
// It also accumulates the all-time money leaderboard (wins + net winnings per
// address) server-side — the client used to rebuild it by scanning every
// MatchSettled log from block 0 on each visit, one getMatch per log.

import type { Address } from "viem";
import type { RedisLike } from "./persistence/redis-store.js";

export interface MoneyRow {
  address: Address;
  wins: number;
  /** TRUE net winnings in token wei (bigint as string): prizes received minus
   *  stakes lost — the exact definition the app's personal "Net winnings"
   *  uses, so the board and a player's own record can never tell two
   *  different stories. (It used to be the raw prize sum, which overstated a
   *  player by every stake they ever posted — 13.34 "won" on the board while
   *  their own record said +0.09.) Can be negative. */
  netWei: string;
}

type Board = Record<string, { wins: number; netWei: string }>;

export interface LedgerStore {
  loadCounted(): Promise<string[]>;
  addCounted(matchId: string): Promise<void>;
  removeCounted(matchId: string): Promise<void>;
  lastBlock(): Promise<bigint | null>;
  setLastBlock(b: bigint): Promise<void>;
  loadBoard(): Promise<Board>;
  saveBoard(b: Board): Promise<void>;
}

export class InMemoryLedgerStore implements LedgerStore {
  private counted: string[] = [];
  private block: bigint | null = null;
  private board: Board = {};
  async loadCounted() {
    return this.counted;
  }
  async addCounted(id: string) {
    this.counted.push(id);
  }
  async removeCounted(id: string) {
    this.counted = this.counted.filter((x) => x !== id);
  }
  async lastBlock() {
    return this.block;
  }
  async setLastBlock(b: bigint) {
    this.block = b;
  }
  async loadBoard() {
    return this.board;
  }
  async saveBoard(b: Board) {
    this.board = b;
  }
}

const COUNTED_KEY = "awale:settled:counted";
const BLOCK_KEY = "awale:settled:lastblock";
// v2: the board metric changed meaning (raw prize sum → true net). Old rows
// can't be converted (the stakes weren't recorded), so the board restarts
// clean under a new key rather than mixing two definitions in one list.
// Counted ids / lastBlock keep their keys — dedup history stays valid.
const BOARD_KEY = "awale:settled:board:v2";

export class RedisLedgerStore implements LedgerStore {
  constructor(private readonly redis: RedisLike) {}
  async loadCounted(): Promise<string[]> {
    return this.redis.smembers(COUNTED_KEY);
  }
  async addCounted(matchId: string): Promise<void> {
    await this.redis.sadd(COUNTED_KEY, matchId);
  }
  async removeCounted(matchId: string): Promise<void> {
    await this.redis.srem(COUNTED_KEY, matchId);
  }
  async lastBlock(): Promise<bigint | null> {
    const raw = await this.redis.get(BLOCK_KEY);
    return raw ? BigInt(raw) : null;
  }
  async setLastBlock(b: bigint): Promise<void> {
    await this.redis.set(BLOCK_KEY, b.toString());
  }
  async loadBoard(): Promise<Board> {
    const raw = await this.redis.get(BOARD_KEY);
    return raw ? (JSON.parse(raw) as Board) : {};
  }
  async saveBoard(b: Board): Promise<void> {
    await this.redis.set(BOARD_KEY, JSON.stringify(b));
  }
}

export class SettledLedger {
  // counted ids mirrored in memory so the hot-path check is synchronous-cheap;
  // hydrated once on first use, kept in sync with the store on every add.
  private counted: Set<string> | null = null;

  constructor(private readonly store: LedgerStore) {}

  private async ids(): Promise<Set<string>> {
    if (!this.counted) this.counted = new Set(await this.store.loadCounted());
    return this.counted;
  }

  async isCounted(matchId: string): Promise<boolean> {
    return (await this.ids()).has(matchId);
  }

  /** Claim a match id for crediting. Returns false if it was already taken —
   *  callers skip everything downstream, which is what makes the whole
   *  MatchSettled pipeline idempotent across watcher + backfill + restarts. */
  async claim(matchId: string): Promise<boolean> {
    const ids = await this.ids();
    if (ids.has(matchId)) return false;
    ids.add(matchId);
    await this.store.addCounted(matchId);
    return true;
  }

  /** Release a claimed id after a downstream failure, so the settlement is
   *  re-processed next time instead of being silently dropped forever (a chain
   *  read failing right after claim used to permanently lose the credit). */
  async release(matchId: string): Promise<void> {
    (await this.ids()).delete(matchId);
    await this.store.removeCounted(matchId);
  }

  /** Fold one settled match into the all-time money board, double-entry:
   *  the winner is up `prize − stake` (their own stake came back inside the
   *  prize), the loser is down their stake. Draws refund both stakes — no
   *  winner, nothing moves. This keeps the board's number the SAME metric as
   *  the app's personal "Net winnings" card. */
  async recordSettle(winner: Address, loser: Address, prizeWei: bigint, stakeWei: bigint): Promise<void> {
    const board = await this.store.loadBoard();
    const w = winner.toLowerCase();
    const l = loser.toLowerCase();
    const curW = board[w] ?? { wins: 0, netWei: "0" };
    board[w] = { wins: curW.wins + 1, netWei: (BigInt(curW.netWei) + prizeWei - stakeWei).toString() };
    const curL = board[l] ?? { wins: 0, netWei: "0" };
    board[l] = { wins: curL.wins, netWei: (BigInt(curL.netWei) - stakeWei).toString() };
    await this.store.saveBoard(board);
  }

  /** Biggest net winners first (ties: more wins first). Only players with at
   *  least one win appear — it is a board of winners, not a loss registry. */
  async top(n: number): Promise<MoneyRow[]> {
    const board = await this.store.loadBoard();
    return Object.entries(board)
      .filter(([, r]) => r.wins > 0)
      .map(([address, r]) => ({ address: address as Address, wins: r.wins, netWei: r.netWei }))
      .sort((a, b) => {
        const d = BigInt(b.netWei) - BigInt(a.netWei);
        return d > 0n ? 1 : d < 0n ? -1 : b.wins - a.wins;
      })
      .slice(0, n);
  }

  lastBlock(): Promise<bigint | null> {
    return this.store.lastBlock();
  }
  setLastBlock(b: bigint): Promise<void> {
    return this.store.setLastBlock(b);
  }
}
