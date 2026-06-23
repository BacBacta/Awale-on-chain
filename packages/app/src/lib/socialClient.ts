// Challenge-a-friend: the social loop that fixes liquidity (play your people, not
// strangers) and drives viral growth (every invite onboards a contact). Builds on
// the async match service + the durable social graph (friends + challenge inbox).

import type { Address } from "viem";
import { createSessionKey, persistSession } from "./session.js";
import { createAsync, recordAsyncMatch } from "./asyncClient.js";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

export interface Challenge {
  id: string;
  from: Address;
  matchId: string;
  createdAt: number;
}

export function socialEnabled(): boolean {
  return !!SERVER_URL;
}

/** The shareable link that drops a friend straight into your game. */
export function inviteLink(matchId: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/play?async=${matchId}`;
}

/** Open WhatsApp / the native share sheet with a pre-filled challenge. */
export async function shareInvite(matchId: string, fromName: string): Promise<void> {
  const url = inviteLink(matchId);
  const text = `${fromName} challenged you to a game of Awalé — tap to play: ${url}`;
  // native share first (best on mobile), then WhatsApp, then clipboard
  if (typeof navigator !== "undefined" && navigator.share) {
    try {
      await navigator.share({ title: "Awalé challenge", text, url });
      return;
    } catch {
      /* user cancelled — fall through */
    }
  }
  const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
  if (typeof window !== "undefined") window.open(wa, "_blank");
}

/** Create a fresh correspondence game to challenge into; returns its matchId. */
export async function startChallengeMatch(): Promise<string> {
  const session = createSessionKey();
  const matchId = await createAsync(session.address);
  persistSession(BigInt(matchId), session);
  recordAsyncMatch(matchId);
  return matchId;
}

/** Challenge a known rival (by address): creates the game and drops it into their
 *  inbox (+ push). Returns the matchId so the caller can also share a link. */
export async function challengeRival(me: Address, rival: Address): Promise<string> {
  const matchId = await startChallengeMatch();
  await fetch(`${SERVER_URL}/social/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: me, to: rival, matchId }),
  }).catch(() => {});
  return matchId;
}

export async function listChallenges(address: Address): Promise<Challenge[]> {
  if (!SERVER_URL) return [];
  const res = await fetch(`${SERVER_URL}/social/challenges?address=${address}`);
  if (!res.ok) return [];
  const { challenges } = (await res.json()) as { challenges: Challenge[] };
  return challenges;
}

export async function dismissChallenge(address: Address, id: string): Promise<void> {
  await fetch(`${SERVER_URL}/social/challenge/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, id }),
  }).catch(() => {});
}

export async function befriend(a: Address, b: Address): Promise<void> {
  await fetch(`${SERVER_URL}/social/befriend`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ a, b }),
  }).catch(() => {});
}
