import type { Address } from "viem";
import type { EventRecord, StatsSnapshot, TokenAgg } from "./types.js";

const DAY = 86_400;

/**
 * Aggregate the public /stats metrics from normalised events. Pure and
 * deterministic so it is fully unit-testable without a chain.
 *
 * Note: network fees paid and failed-transaction rate are not derivable from
 * logs alone (they need transaction receipts / gas), so they are out of scope
 * here and surfaced as "—" in the UI.
 *
 * @param now unix seconds, the reference time for DAU/MAU/retention windows
 * @param tokenSymbols optional address(lowercase) -> symbol labels
 */
export function computeStats(
  events: EventRecord[],
  now: number,
  tokenSymbols: Record<string, string> = {},
): StatsSnapshot {
  let created = 0;
  let settled = 0;
  let voided = 0;

  const players = new Set<string>();
  const activeDays = new Map<string, Set<number>>(); // address -> set of active day numbers
  const firstSeen = new Map<string, number>(); // address -> earliest timestamp

  const matchToken = new Map<string, { token: Address; stake: bigint }>();
  const volume = new Map<string, bigint>(); // token -> summed pot
  const revenue = new Map<string, bigint>(); // token -> summed rake
  const tokenSet = new Set<string>();

  const touch = (addr: Address, ts: number) => {
    const a = addr.toLowerCase();
    players.add(a);
    let days = activeDays.get(a);
    if (!days) activeDays.set(a, (days = new Set()));
    days.add(Math.floor(ts / DAY));
    const prev = firstSeen.get(a);
    if (prev === undefined || ts < prev) firstSeen.set(a, ts);
  };

  for (const e of events) {
    switch (e.type) {
      case "created":
        created++;
        matchToken.set(e.matchId.toString(), { token: e.token, stake: e.stake });
        tokenSet.add(e.token.toLowerCase());
        touch(e.player0, e.timestamp);
        break;
      case "joined":
        touch(e.player1, e.timestamp);
        break;
      case "settled": {
        settled++;
        const m = matchToken.get(e.matchId.toString());
        if (m) {
          const key = m.token.toLowerCase();
          volume.set(key, (volume.get(key) ?? 0n) + m.stake * 2n);
          tokenSet.add(key);
        }
        break;
      }
      case "voided":
        voided++;
        break;
      case "fee": {
        const key = e.token.toLowerCase();
        revenue.set(key, (revenue.get(key) ?? 0n) + e.amount);
        tokenSet.add(key);
        break;
      }
    }
  }

  const dauCut = now - DAY;
  const mauCut = now - 30 * DAY;
  const currentDay = Math.floor(now / DAY);

  let dau = 0;
  let mau = 0;
  for (const [, days] of activeDays) {
    let activeDay = false;
    let activeMonth = false;
    for (const d of days) {
      const ts = d * DAY;
      if (ts >= dauCut) activeDay = true;
      if (ts >= mauCut) activeMonth = true;
    }
    if (activeDay) dau++;
    if (activeMonth) mau++;
  }

  const retention = (n: number): number => {
    let eligible = 0;
    let retained = 0;
    for (const [addr, ts] of firstSeen) {
      const firstDay = Math.floor(ts / DAY);
      if (currentDay - firstDay < n) continue; // not enough time elapsed
      eligible++;
      if (activeDays.get(addr)?.has(firstDay + n)) retained++;
    }
    return eligible === 0 ? 0 : retained / eligible;
  };

  const perToken: TokenAgg[] = [...tokenSet].map((key) => ({
    token: key as Address,
    symbol: tokenSymbols[key],
    volume: (volume.get(key) ?? 0n).toString(),
    revenue: (revenue.get(key) ?? 0n).toString(),
  }));

  return {
    generatedAt: now,
    matches: { created, settled, voided, open: Math.max(0, created - settled - voided) },
    uniquePlayers: players.size,
    dau,
    mau,
    retention: { d1: retention(1), d7: retention(7), d30: retention(30) },
    perToken,
  };
}
