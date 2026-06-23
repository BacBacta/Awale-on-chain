// Clubs: your crew (WhatsApp group) as a durable roster with a shareable join
// code. The home for recurring group play — club tournaments reuse the tournament
// flow, ranking reuses the leaderboard.

import type { Address } from "viem";
import type { Tournament } from "./tournaments.js";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

export interface Club {
  id: string;
  name: string;
  code: string;
  owner: Address;
  members: Address[];
  createdAt: number;
}

export function clubsEnabled(): boolean {
  return !!SERVER_URL;
}

export async function createClub(name: string, owner: Address): Promise<Club> {
  const res = await fetch(`${SERVER_URL}/clubs/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, owner }),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Could not create club");
  return (await res.json()) as Club;
}

export async function joinClub(code: string, member: Address): Promise<Club> {
  const res = await fetch(`${SERVER_URL}/clubs/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, member }),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Could not join — check the code");
  return (await res.json()) as Club;
}

export async function myClubs(address: Address): Promise<Club[]> {
  if (!SERVER_URL) return [];
  const res = await fetch(`${SERVER_URL}/clubs/mine?address=${address}`);
  if (!res.ok) return [];
  return ((await res.json()) as { clubs: Club[] }).clubs;
}

export async function getClub(id: string): Promise<Club | null> {
  if (!SERVER_URL) return null;
  const res = await fetch(`${SERVER_URL}/clubs/get?id=${id}`);
  return res.ok ? ((await res.json()) as Club) : null;
}

/** Start a private club tournament (the server operator creates it on-chain). */
export async function startClubTournament(
  clubId: string,
  token: Address,
  entryFee: string,
  maxPlayers = 8,
): Promise<string> {
  const res = await fetch(`${SERVER_URL}/clubs/tournament`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clubId, token, entryFee, maxPlayers }),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Could not start the club game");
  return ((await res.json()) as { id: string }).id;
}

/** A club's tournaments (any phase). */
export async function listClubTournaments(clubId: string): Promise<Tournament[]> {
  if (!SERVER_URL) return [];
  const res = await fetch(`${SERVER_URL}/clubs/tournaments?clubId=${clubId}`);
  if (!res.ok) return [];
  return ((await res.json()) as { tournaments: Tournament[] }).tournaments;
}

/** Share a club's join code (WhatsApp / native share). */
export async function shareClub(club: Club): Promise<void> {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const text = `Join my Awalé club "${club.name}" — open ${origin}/clubs and enter code ${club.code}`;
  if (typeof navigator !== "undefined" && navigator.share) {
    try {
      await navigator.share({ title: `Awalé club: ${club.name}`, text });
      return;
    } catch {
      /* cancelled */
    }
  }
  if (typeof window !== "undefined") window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
}
