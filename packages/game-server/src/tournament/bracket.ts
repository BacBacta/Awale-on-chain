// Single-elimination bracket logic for Sit-and-Go tournaments — pure and
// deterministic, so it unit-tests without a chain or sockets. The service layer
// pairs each pending bracket match into a live session-key game and feeds the
// winner back via reportResult; this module only tracks who advances.

import type { Address } from "viem";

export interface BracketMatch {
  a: Address;
  b: Address | null; // null ⇒ a bye (a auto-advances)
  winner: Address | null;
}

export interface Bracket {
  rounds: BracketMatch[][]; // rounds[0] = first round … last = final
}

const lc = (a: Address) => a.toLowerCase() as Address;

/** Seed a bracket from an entrant list. Non-power-of-two fields get byes in the
 *  first round (top seeds advance free), so any field size 2..N is supported. */
export function createBracket(players: Address[]): Bracket {
  if (players.length < 2) throw new Error("bracket: need at least 2 players");
  const size = 1 << Math.ceil(Math.log2(players.length)); // next power of two
  const real = players.map(lc);
  const byes = size - real.length;

  // Byes go to the top seeds: the first `byes` players get a solo match (already
  // won); everyone else pairs up. This keeps the round at size/2 matches with no
  // empty (null-vs-null) slots.
  const first: BracketMatch[] = [];
  let pi = 0;
  for (let i = 0; i < byes; i++) {
    const a = real[pi++];
    first.push({ a, b: null, winner: a });
  }
  while (pi < real.length) {
    const a = real[pi++];
    const b = real[pi++];
    first.push({ a, b, winner: null });
  }
  const bracket: Bracket = { rounds: [first] };
  growRounds(bracket);
  return bracket;
}

/** Append empty later rounds and propagate any byes that already resolved. */
function growRounds(bracket: Bracket) {
  let count = bracket.rounds[0].length;
  while (count > 1) {
    count = Math.ceil(count / 2);
    bracket.rounds.push(
      Array.from({ length: count }, () => ({ a: null as unknown as Address, b: null, winner: null }))
    );
  }
  // carry first-round byes forward as far as they auto-advance
  for (let r = 0; r < bracket.rounds.length - 1; r++) {
    bracket.rounds[r].forEach((m, i) => {
      if (m.winner) placeWinner(bracket, r, i, m.winner);
    });
  }
}

function placeWinner(bracket: Bracket, round: number, index: number, winner: Address) {
  const next = bracket.rounds[round + 1];
  if (!next) return;
  const slot = next[index >> 1];
  if (index % 2 === 0) slot.a = winner;
  else slot.b = winner;
}

/** Matches that have both players assigned but no winner yet — i.e. games the
 *  service should be running right now. */
export function pendingMatches(bracket: Bracket): { round: number; index: number; a: Address; b: Address }[] {
  const out: { round: number; index: number; a: Address; b: Address }[] = [];
  bracket.rounds.forEach((round, r) =>
    round.forEach((m, i) => {
      if (!m.winner && m.a && m.b) out.push({ round: r, index: i, a: m.a, b: m.b });
    })
  );
  return out;
}

/** Record a game's winner and advance them. Throws on an unknown match or a
 *  winner who isn't one of the two seated players. */
export function reportResult(bracket: Bracket, round: number, index: number, winner: Address): void {
  const m = bracket.rounds[round]?.[index];
  if (!m) throw new Error("bracket: no such match");
  if (m.winner) throw new Error("bracket: already decided");
  const w = lc(winner);
  if (w !== m.a?.toLowerCase() && w !== m.b?.toLowerCase()) throw new Error("bracket: winner not in match");
  m.winner = w;
  placeWinner(bracket, round, index, w);
}

export function isComplete(bracket: Bracket): boolean {
  const final = bracket.rounds[bracket.rounds.length - 1][0];
  return !!final.winner;
}

export function champion(bracket: Bracket): Address | null {
  return bracket.rounds[bracket.rounds.length - 1][0].winner;
}

/** Ordered top finishers [champion, runner-up] for the on-chain payout table.
 *  Runner-up is the loser of the final. Returns [] until the bracket is complete. */
export function finalStandings(bracket: Bracket): Address[] {
  if (!isComplete(bracket)) return [];
  const final = bracket.rounds[bracket.rounds.length - 1][0];
  const champ = final.winner as Address;
  const runnerUp = final.a?.toLowerCase() === champ.toLowerCase() ? final.b : final.a;
  return runnerUp ? [champ, runnerUp] : [champ];
}
