import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { InMemoryClubStore, RedisClubStore, type ClubStore } from "../src/clubs/store.js";
import type { RedisLike } from "../src/persistence/redis-store.js";

class FakeRedis implements RedisLike {
  kv = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  async get(k: string) {
    return this.kv.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.kv.set(k, v);
  }
  async del(k: string) {
    this.kv.delete(k);
  }
  async sadd(k: string, m: string) {
    (this.sets.get(k) ?? this.sets.set(k, new Set()).get(k)!).add(m);
  }
  async srem(k: string, m: string) {
    this.sets.get(k)?.delete(m);
  }
  async smembers(k: string) {
    return [...(this.sets.get(k) ?? [])];
  }
}

const A: Address = "0x000000000000000000000000000000000000000A";
const B: Address = "0x000000000000000000000000000000000000000b";
const C: Address = "0x000000000000000000000000000000000000000C";

function suite(name: string, make: () => ClubStore) {
  describe(name, () => {
    it("creates a club with the owner as first member + a code", async () => {
      const s = make();
      const club = await s.create("Accra Crew", A);
      expect(club.name).toBe("Accra Crew");
      expect(club.code).toMatch(/^[A-Z2-9]{6}$/);
      expect(club.members.map((m) => m.toLowerCase())).toEqual([A.toLowerCase()]);
      expect((await s.get(club.id))?.id).toBe(club.id);
    });

    it("lets others join by code and dedupes", async () => {
      const s = make();
      const club = await s.create("Crew", A);
      await s.joinByCode(club.code.toLowerCase(), B); // case-insensitive
      await s.joinByCode(club.code, B); // dupe — no-op
      await s.joinByCode(club.code, C);
      const after = await s.get(club.id);
      expect(after?.members.map((m) => m.toLowerCase()).sort()).toEqual(
        [A, B, C].map((m) => m.toLowerCase()).sort(),
      );
    });

    it("rejects an unknown code", async () => {
      const s = make();
      await expect(s.joinByCode("ZZZZZZ", B)).rejects.toThrow(/no club/);
    });

    it("lists clubs a member belongs to", async () => {
      const s = make();
      const c1 = await s.create("One", A);
      const c2 = await s.create("Two", B);
      await s.joinByCode(c2.code, A);
      const mine = await s.listForMember(A);
      expect(mine.map((c) => c.id).sort()).toEqual([c1.id, c2.id].sort());
      expect((await s.listForMember(C)).length).toBe(0);
    });

    it("rejects an empty name", async () => {
      const s = make();
      await expect(s.create("   ", A)).rejects.toThrow(/name required/);
    });

    it("tags on-chain tournaments to a club, both directions", async () => {
      const s = make();
      const club = await s.create("Crew", A);
      await s.tagTournament(club.id, "7");
      await s.tagTournament(club.id, "9");
      expect((await s.tournamentsOf(club.id)).sort()).toEqual(["7", "9"]);
      expect(await s.clubOf("7")).toBe(club.id);
      expect(await s.clubOf("404")).toBeNull();
    });
  });
}

suite("InMemoryClubStore", () => new InMemoryClubStore());
suite("RedisClubStore", () => new RedisClubStore(new FakeRedis()));
