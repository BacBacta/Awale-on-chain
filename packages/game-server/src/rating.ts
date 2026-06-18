// Applies a finished match to the leaderboard: updates both players' Elo and
// win/loss/draw counters, and records the result.

import { updateElo, scoreForWinner } from "./elo.js";
import type { LeaderboardStore, MatchResult, PlayerRating } from "./store/types.js";

export async function applyMatchResult(
  store: LeaderboardStore,
  r: MatchResult,
): Promise<[PlayerRating, PlayerRating]> {
  const a = await store.getRating(r.player0);
  const b = await store.getRating(r.player1);

  const score0 = scoreForWinner(r.winner);
  const [elo0, elo1] = updateElo(a.elo, b.elo, score0);

  const n0: PlayerRating = {
    ...a,
    elo: elo0,
    games: a.games + 1,
    wins: a.wins + (r.winner === 0 ? 1 : 0),
    losses: a.losses + (r.winner === 1 ? 1 : 0),
    draws: a.draws + (r.winner === 2 ? 1 : 0),
  };
  const n1: PlayerRating = {
    ...b,
    elo: elo1,
    games: b.games + 1,
    wins: b.wins + (r.winner === 1 ? 1 : 0),
    losses: b.losses + (r.winner === 0 ? 1 : 0),
    draws: b.draws + (r.winner === 2 ? 1 : 0),
  };

  await store.setRating(n0);
  await store.setRating(n1);
  await store.recordResult(r);
  return [n0, n1];
}
