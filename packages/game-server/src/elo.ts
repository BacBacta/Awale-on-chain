// Standard Elo rating maths for ranked matchmaking.

/** Expected score of A against B (0..1). */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/**
 * K-factor schedule (P1-5), FIDE-inspired:
 *  - provisional players move fast so a new account finds its level quickly
 *    (K=40 under 30 games);
 *  - established elites move slowly so the top of the ladder is stable and
 *    hard to farm (K=20 at/above 2100);
 *  - everyone else K=32.
 * `games` is the player's experience count (total games), a fine proxy for
 * "provisional"; `rating` is their current pool rating.
 */
export function kFactor(games: number, rating: number): number {
  if (games < 30) return 40;
  if (rating >= 2100) return 20;
  return 32;
}

/**
 * Updated ratings after a game, SAME K for both players.
 * @param scoreA  1 = A won, 0.5 = draw, 0 = A lost
 * @param k       K-factor (volatility); 32 is a common default
 */
export function updateElo(ratingA: number, ratingB: number, scoreA: 0 | 0.5 | 1, k = 32): [number, number] {
  return updateEloPair(ratingA, ratingB, scoreA, k, k);
}

/**
 * Updated ratings after a game with a PER-PLAYER K (FIDE uses each player's own
 * K, so a provisional beginner and an established veteran move by different
 * amounts from the same game). Expected scores still use the pre-game ratings.
 */
export function updateEloPair(
  ratingA: number,
  ratingB: number,
  scoreA: 0 | 0.5 | 1,
  kA: number,
  kB: number,
): [number, number] {
  const ea = expectedScore(ratingA, ratingB);
  const eb = 1 - ea;
  const scoreB = (1 - scoreA) as 0 | 0.5 | 1;
  const newA = Math.round(ratingA + kA * (scoreA - ea));
  const newB = Math.round(ratingB + kB * (scoreB - eb));
  return [newA, newB];
}

/** Map an Awalé winner (0, 1, or 2=draw) to player 0's Elo score. */
export function scoreForWinner(winner: number): 0 | 0.5 | 1 {
  if (winner === 0) return 1;
  if (winner === 1) return 0;
  return 0.5;
}
