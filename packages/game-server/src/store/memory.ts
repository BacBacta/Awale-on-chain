// In-memory stores — the default for local dev and the basis for unit tests.

import type { Address } from "viem";
import type { MatchSnapshot } from "../match.js";
import { type LiveMatchStore, type LeaderboardStore, type PlayerRating, type MatchResult, newRating } from "./types.js";

export class InMemoryLiveMatchStore implements LiveMatchStore {
  private readonly map = new Map<string, MatchSnapshot>();

  async save(snap: MatchSnapshot): Promise<void> {
    this.map.set(snap.matchId.toString(), snap);
  }
  async load(matchId: bigint): Promise<MatchSnapshot | null> {
    return this.map.get(matchId.toString()) ?? null;
  }
  async remove(matchId: bigint): Promise<void> {
    this.map.delete(matchId.toString());
  }
  async list(): Promise<bigint[]> {
    return [...this.map.keys()].map((k) => BigInt(k));
  }
}

export class InMemoryLeaderboardStore implements LeaderboardStore {
  private readonly ratings = new Map<string, PlayerRating>();
  private readonly results: MatchResult[] = [];

  async getRating(address: Address): Promise<PlayerRating> {
    return this.ratings.get(address.toLowerCase()) ?? newRating(address);
  }
  async setRating(rating: PlayerRating): Promise<void> {
    this.ratings.set(rating.address.toLowerCase(), rating);
  }
  async recordResult(result: MatchResult): Promise<void> {
    this.results.push(result);
  }
  async top(n: number): Promise<PlayerRating[]> {
    return [...this.ratings.values()].sort((a, b) => b.elo - a.elo).slice(0, n);
  }
  /** Test/diagnostic helper. */
  async history(): Promise<MatchResult[]> {
    return [...this.results];
  }
}
