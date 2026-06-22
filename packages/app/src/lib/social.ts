// Lightweight social graph (device-local). Records opponents you've faced so you
// can re-challenge them ("rematch"/rivalry seed) without a backend. A durable,
// cross-device friends graph needs wallet identity + persistence (Redis) — see
// docs/async-push-milestone.md; this is the first, universal version.

import type { Address } from "viem";

const KEY = "awale.opponents";
const MAX = 12;
const ZERO = "0x0000000000000000000000000000000000000000";

export function recordOpponent(address?: Address | null): void {
  if (!address || address === ZERO || typeof localStorage === "undefined") return;
  try {
    const list = listOpponents().filter((a) => a.toLowerCase() !== address.toLowerCase());
    localStorage.setItem(KEY, JSON.stringify([address, ...list].slice(0, MAX)));
  } catch {
    /* ignore */
  }
}

export function listOpponents(): Address[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Address[]) : [];
  } catch {
    return [];
  }
}
