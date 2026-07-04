// Applies a finished match to the leaderboard: updates both players' Elo and
// win/loss/draw counters, and records the result.

import { updateEloPair, scoreForWinner, kFactor } from "./elo.js";
import type { LeaderboardStore, MatchResult, PlayerRating } from "./store/types.js";

export async function applyMatchResult(
  store: LeaderboardStore,
  r: MatchResult,
  pool: "live" | "async" = "live",
): Promise<[PlayerRating, PlayerRating]> {
  const a = await store.getRating(r.player0);
  const b = await store.getRating(r.player1);

  const ra = pool === "live" ? a.eloLive : a.eloAsync;
  const rb = pool === "live" ? b.eloLive : b.eloAsync;
  const score0 = scoreForWinner(r.winner);
  // FIDE-inspired per-player K (P1-5)
  const [na, nb] = updateEloPair(ra, rb, score0, kFactor(a.games, ra), kFactor(b.games, rb));

  const bump = (p: PlayerRating, newRating: number, place: 0 | 1): PlayerRating => {
    const next: PlayerRating = {
      ...p,
      eloLive: pool === "live" ? newRating : p.eloLive,
      eloAsync: pool === "async" ? newRating : p.eloAsync,
      elo: p.elo,
      games: p.games + 1,
      wins: p.wins + (r.winner === place ? 1 : 0),
      losses: p.losses + (r.winner === (1 - place) ? 1 : 0),
      draws: p.draws + (r.winner === 2 ? 1 : 0),
    };
    next.elo = next.eloLive; // legacy mirror
    return next;
  };
  const n0 = bump(a, na, 0);
  const n1 = bump(b, nb, 1);

  await store.setRating(n0);
  await store.setRating(n1);
  await store.recordResult(r);
  return [n0, n1];
}
