// Server-served open-match lobby (P2-8). The client used to make up to 40
// sequential getMatch reads per refresh AND each client ran the CrossMatchOffer
// convergence patch independently (so two waiting rooms only merged if BOTH
// clients had it). Both move here: the server scans once, caches, and serves a
// ready-made view — ordering, the viewer's own matches, and the convergence
// target — to every client. The client keeps its on-chain scan only as a
// fallback when the server is unreachable.

import type { Address } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000";

/** An open (joinable) cash match as read from MatchEscrow. */
export interface RawOpenMatch {
  id: bigint;
  stake: bigint;
  token: Address;
  creator: Address;
  rakeBps: number;
}

/** JSON-safe (bigints as strings) open match in a lobby response. */
export interface LobbyMatch {
  id: string;
  stake: string;
  token: Address;
  creator: Address;
  rakeBps: number;
  mine: boolean;
}

export interface LobbySnapshot {
  /** Joinable matches created by OTHERS, newest first. */
  matches: LobbyMatch[];
  /** The viewer's own open matches (cancellable, not joinable by them). */
  mine: LobbyMatch[];
  /** If the viewer has an open match AND an OLDER one at the same token+stake
   *  exists, the id of that older match — the client should JOIN it (converge)
   *  instead of leaving two rooms waiting in parallel. null otherwise. */
  convergeTo: string | null;
}

function sameStake(a: RawOpenMatch, b: RawOpenMatch): boolean {
  return a.token.toLowerCase() === b.token.toLowerCase() && a.stake === b.stake;
}

function toLobbyMatch(m: RawOpenMatch, viewer?: string): LobbyMatch {
  return {
    id: m.id.toString(),
    stake: m.stake.toString(),
    token: m.token,
    creator: m.creator,
    rakeBps: m.rakeBps,
    mine: !!viewer && m.creator.toLowerCase() === viewer,
  };
}

/**
 * Build the lobby view for `viewer` from the raw open matches. Pure and
 * deterministic — the periodic scan feeds `raw`; this shapes it.
 */
export function buildLobby(raw: readonly RawOpenMatch[], viewer?: Address): LobbySnapshot {
  const v = viewer?.toLowerCase();
  // newest first (id increases with creation order)
  const sorted = [...raw].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const mineRaw = v ? sorted.filter((m) => m.creator.toLowerCase() === v) : [];
  const others = sorted.filter((m) => !v || m.creator.toLowerCase() !== v);

  // Convergence: for any of the viewer's own matches, is there an OLDER (smaller
  // id) match at the same token+stake owned by someone else? If so, the viewer
  // should join the OLDEST such match rather than wait in a parallel room.
  let convergeTo: string | null = null;
  if (mineRaw.length > 0) {
    let best: RawOpenMatch | null = null;
    for (const own of mineRaw) {
      for (const other of others) {
        if (sameStake(own, other) && other.id < own.id) {
          if (!best || other.id < best.id) best = other; // the oldest wins
        }
      }
    }
    convergeTo = best ? best.id.toString() : null;
  }

  return {
    matches: others.map((m) => toLobbyMatch(m, v)),
    mine: mineRaw.map((m) => toLobbyMatch(m, v)),
    convergeTo,
  };
}

/** Reader over the escrow — returns the currently-open matches (status Open,
 *  no second player). Injected so the service is testable without a chain. */
export type OpenMatchScanner = () => Promise<RawOpenMatch[]>;

/**
 * Caches the open-match list and refreshes it on an interval, so every client's
 * lobby is served from ONE scan instead of each client scanning the chain.
 */
export class LobbyService {
  private cache: RawOpenMatch[] = [];
  private lastRefresh = 0;

  constructor(
    private readonly scan: OpenMatchScanner,
    private readonly now: () => number = Date.now,
  ) {}

  async refresh(): Promise<void> {
    this.cache = await this.scan();
    this.lastRefresh = this.now();
  }

  /** Never throws: a scan failure keeps the last good cache (the client can
   *  still fall back to its own on-chain read if this is empty/stale). */
  async refreshSafe(): Promise<void> {
    try {
      await this.refresh();
    } catch {
      /* keep the stale cache */
    }
  }

  snapshot(viewer?: Address): LobbySnapshot & { ageMs: number } {
    return { ...buildLobby(this.cache, viewer), ageMs: this.now() - this.lastRefresh };
  }
}
