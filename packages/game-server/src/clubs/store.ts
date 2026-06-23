// Clubs: named groups of players (your WhatsApp crew) with a shared roster and a
// short invite code. Clubs are the home for recurring group play — club
// tournaments reuse TournamentEscrow, ranking reuses the leaderboard. Keyed by a
// generated club id; members are wallet addresses (the stable cross-device id).
// In-memory by default; RedisClubStore makes it durable + shared across machines
// (same RedisLike as the match/social stores).

import type { Address } from "viem";
import type { RedisLike } from "../persistence/redis-store.js";

export interface Club {
  id: string;
  name: string;
  code: string; // short, shareable join code
  owner: Address;
  members: Address[];
  createdAt: number;
}

export interface ClubStore {
  create(name: string, owner: Address): Promise<Club>;
  joinByCode(code: string, member: Address): Promise<Club>;
  get(id: string): Promise<Club | null>;
  listForMember(member: Address): Promise<Club[]>;
}

const lc = (a: Address) => a.toLowerCase() as Address;
// short, unambiguous code (no 0/O/1/I) — easy to read out over WhatsApp
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function makeCode(n = 6): string {
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}
export function makeId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function normalize(name: string): string {
  const t = name.trim().slice(0, 40);
  if (!t) throw new Error("club: name required");
  return t;
}

export class InMemoryClubStore implements ClubStore {
  private byId = new Map<string, Club>();
  private byCode = new Map<string, string>(); // code → id
  private byMember = new Map<string, Set<string>>(); // addr → club ids

  async create(name: string, owner: Address): Promise<Club> {
    const club: Club = {
      id: makeId(),
      name: normalize(name),
      code: this.freshCode(),
      owner: lc(owner),
      members: [lc(owner)],
      createdAt: Date.now(),
    };
    this.byId.set(club.id, club);
    this.byCode.set(club.code, club.id);
    this.index(lc(owner), club.id);
    return club;
  }

  async joinByCode(code: string, member: Address): Promise<Club> {
    const id = this.byCode.get(code.toUpperCase().trim());
    if (!id) throw new Error("club: no club with that code");
    const club = this.byId.get(id)!;
    const m = lc(member);
    if (!club.members.includes(m)) {
      club.members.push(m);
      this.index(m, id);
    }
    return club;
  }

  async get(id: string): Promise<Club | null> {
    return this.byId.get(id) ?? null;
  }

  async listForMember(member: Address): Promise<Club[]> {
    const ids = this.byMember.get(lc(member)) ?? new Set();
    return [...ids].map((id) => this.byId.get(id)).filter((c): c is Club => !!c);
  }

  private index(addr: string, id: string) {
    const s = this.byMember.get(addr) ?? new Set();
    s.add(id);
    this.byMember.set(addr, s);
  }
  private freshCode(): string {
    let c = makeCode();
    while (this.byCode.has(c)) c = makeCode();
    return c;
  }
}

const clubKey = (id: string) => `awale:club:${id}`;
const codeKey = (code: string) => `awale:clubcode:${code}`;
const memberKey = (a: Address) => `awale:clubs:${a.toLowerCase()}`;

/** Redis-backed: club as a JSON blob, a code→id pointer, and a SET of club ids per member. */
export class RedisClubStore implements ClubStore {
  constructor(private readonly redis: RedisLike) {}

  async create(name: string, owner: Address): Promise<Club> {
    let code = makeCode();
    // avoid a code collision (cheap: a couple of tries)
    for (let i = 0; i < 5 && (await this.redis.get(codeKey(code))); i++) code = makeCode();
    const club: Club = {
      id: makeId(),
      name: normalize(name),
      code,
      owner: lc(owner),
      members: [lc(owner)],
      createdAt: Date.now(),
    };
    await this.redis.set(clubKey(club.id), JSON.stringify(club));
    await this.redis.set(codeKey(club.code), club.id);
    await this.redis.sadd(memberKey(lc(owner)), club.id);
    return club;
  }

  async joinByCode(code: string, member: Address): Promise<Club> {
    const id = await this.redis.get(codeKey(code.toUpperCase().trim()));
    if (!id) throw new Error("club: no club with that code");
    const club = await this.get(id);
    if (!club) throw new Error("club: not found");
    const m = lc(member);
    if (!club.members.includes(m)) {
      club.members.push(m);
      await this.redis.set(clubKey(id), JSON.stringify(club));
      await this.redis.sadd(memberKey(m), id);
    }
    return club;
  }

  async get(id: string): Promise<Club | null> {
    const raw = await this.redis.get(clubKey(id));
    return raw ? (JSON.parse(raw) as Club) : null;
  }

  async listForMember(member: Address): Promise<Club[]> {
    const ids = await this.redis.smembers(memberKey(lc(member)));
    const clubs = await Promise.all(ids.map((id) => this.get(id)));
    return clubs.filter((c): c is Club => !!c);
  }
}
