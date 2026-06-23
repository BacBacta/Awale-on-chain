// Tournament orchestration: mirrors the on-chain TournamentEscrow lobby, runs the
// single-elimination bracket once a field fills, and reports the final standings
// back on-chain via an injected finalize hook. State is in-memory (same as the
// matchmaking queue) — consistent with the single-machine deployment.

import type { Address } from "viem";
import {
  createBracket,
  pendingMatches,
  reportResult,
  isComplete,
  finalStandings,
  type Bracket,
} from "./bracket.js";

export type Phase = "lobby" | "running" | "settling" | "done";

export interface TournamentMeta {
  id: string; // on-chain tournament id (stringified bigint)
  token: Address;
  entryFee: string; // token units, stringified
  maxPlayers: number;
  cutBps: number;
  payoutBps: number[];
  joinDeadline: number; // epoch ms
  clubId?: string; // set ⇒ private club tournament (hidden from the public lobby)
}

export interface TournamentState extends TournamentMeta {
  phase: Phase;
  entrants: Address[];
  bracket: Bracket | null;
}

/** Called when a bracket completes, to report standings to TournamentEscrow.finalize. */
export type FinalizeHook = (id: string, winners: Address[]) => Promise<void>;

/** A player's current obligation in a running tournament. */
export interface Assignment {
  round: number;
  index: number;
  role: "host" | "guest"; // host creates the async game, guest joins it
  opponent: Address;
  asyncMatchId: string | null; // set once the host has created the game
}

interface Entry {
  meta: TournamentMeta;
  entrants: Address[];
  phase: Phase;
  bracket: Bracket | null;
  games: Map<string, string>; // "round:index" → asyncMatchId (host-created)
}

export class TournamentService {
  private byId = new Map<string, Entry>();
  constructor(private readonly finalizeHook?: FinalizeHook) {}

  /** Register a tournament the operator just created on-chain. */
  register(meta: TournamentMeta): void {
    if (this.byId.has(meta.id)) return;
    this.byId.set(meta.id, { meta, entrants: [], phase: "lobby", bracket: null, games: new Map() });
  }

  /** Mirror an on-chain join. Starts the bracket once the field is full. */
  join(id: string, player: Address): void {
    const e = this.must(id);
    if (e.phase !== "lobby") throw new Error("tournament: not in lobby");
    const p = player.toLowerCase() as Address;
    if (e.entrants.some((x) => x.toLowerCase() === p)) throw new Error("tournament: already joined");
    if (e.entrants.length >= e.meta.maxPlayers) throw new Error("tournament: full");
    e.entrants.push(p);
    if (e.entrants.length === e.meta.maxPlayers) this.start(id);
  }

  /** Force the bracket to begin (field full, or join deadline reached with ≥2). */
  start(id: string): void {
    const e = this.must(id);
    if (e.phase !== "lobby") return;
    if (e.entrants.length < 2) throw new Error("tournament: under-filled");
    e.bracket = createBracket(e.entrants);
    e.phase = "running";
  }

  /** The games that should be live right now (both seats filled, no winner). */
  pending(id: string): { round: number; index: number; a: Address; b: Address }[] {
    const e = this.must(id);
    return e.bracket ? pendingMatches(e.bracket) : [];
  }

  /** Record a bracket game's winner; finalizes on-chain when the bracket completes. */
  async reportResult(id: string, round: number, index: number, winner: Address): Promise<void> {
    const e = this.must(id);
    if (!e.bracket || e.phase !== "running") throw new Error("tournament: not running");
    reportResult(e.bracket, round, index, winner);
    if (isComplete(e.bracket)) {
      e.phase = "settling";
      const winners = finalStandings(e.bracket);
      if (this.finalizeHook) await this.finalizeHook(id, winners);
      e.phase = "done";
    }
  }

  /** A player's current game obligation, or null if they have none right now
   *  (waiting on another match, eliminated, or the tournament is over). The
   *  lower-address player in each pair is the host (deterministic, so both clients
   *  agree without extra coordination). */
  assignment(id: string, player: Address): Assignment | null {
    const e = this.must(id);
    if (!e.bracket) return null;
    const p = player.toLowerCase();
    for (const m of pendingMatches(e.bracket)) {
      if (m.a.toLowerCase() !== p && m.b.toLowerCase() !== p) continue;
      const host = BigInt(m.a) < BigInt(m.b) ? m.a : m.b;
      const opponent = (m.a.toLowerCase() === p ? m.b : m.a) as Address;
      return {
        round: m.round,
        index: m.index,
        role: host.toLowerCase() === p ? "host" : "guest",
        opponent,
        asyncMatchId: e.games.get(`${m.round}:${m.index}`) ?? null,
      };
    }
    return null;
  }

  /** The host records the async game it created so the guest can join it. */
  attachGame(id: string, round: number, index: number, asyncMatchId: string): void {
    const e = this.must(id);
    if (!e.bracket) throw new Error("tournament: not running");
    e.games.set(`${round}:${index}`, asyncMatchId);
  }

  state(id: string): TournamentState {
    const e = this.must(id);
    return { ...e.meta, phase: e.phase, entrants: e.entrants, bracket: e.bracket };
  }

  list(): TournamentState[] {
    return [...this.byId.values()].map((e) => ({
      ...e.meta,
      phase: e.phase,
      entrants: e.entrants,
      bracket: e.bracket,
    }));
  }

  /** Open PUBLIC tournaments still accepting entrants (the main lobby). Club
   *  tournaments are private — they only show in clubLobbies(). */
  openLobbies(): TournamentState[] {
    return this.list().filter((t) => t.phase === "lobby" && t.entrants.length < t.maxPlayers && !t.clubId);
  }

  /** A club's tournaments (any phase), newest first. */
  clubLobbies(clubId: string): TournamentState[] {
    return this.list()
      .filter((t) => t.clubId === clubId)
      .sort((a, b) => Number(b.id) - Number(a.id));
  }

  /** Tag an already-registered tournament with its club (used when re-syncing). */
  setClub(id: string, clubId: string): void {
    const e = this.byId.get(id);
    if (e) e.meta.clubId = clubId;
  }

  private must(id: string): Entry {
    const e = this.byId.get(id);
    if (!e) throw new Error(`tournament: unknown id ${id}`);
    return e;
  }
}
