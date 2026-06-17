// Standard Elo rating maths for ranked matchmaking.

/** Expected score of A against B (0..1). */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/**
 * Updated ratings after a game.
 * @param scoreA  1 = A won, 0.5 = draw, 0 = A lost
 * @param k       K-factor (volatility); 32 is a common default
 */
export function updateElo(ratingA: number, ratingB: number, scoreA: 0 | 0.5 | 1, k = 32): [number, number] {
  const ea = expectedScore(ratingA, ratingB);
  const eb = 1 - ea;
  const scoreB = (1 - scoreA) as 0 | 0.5 | 1;
  const newA = Math.round(ratingA + k * (scoreA - ea));
  const newB = Math.round(ratingB + k * (scoreB - eb));
  return [newA, newB];
}

/** Map an Awalé winner (0, 1, or 2=draw) to player 0's Elo score. */
export function scoreForWinner(winner: number): 0 | 0.5 | 1 {
  if (winner === 0) return 1;
  if (winner === 1) return 0;
  return 0.5;
}
