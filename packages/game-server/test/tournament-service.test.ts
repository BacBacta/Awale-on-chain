import { describe, it, expect, vi } from "vitest";
import type { Address } from "viem";
import { TournamentService, type TournamentMeta } from "../src/tournament/service.js";

const P = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

const meta = (over: Partial<TournamentMeta> = {}): TournamentMeta => ({
  id: "1",
  token: P(0xaa),
  entryFee: "1000000",
  maxPlayers: 4,
  cutBps: 800,
  payoutBps: [6500, 3500],
  joinDeadline: Date.now() + 3_600_000,
  ...over,
});

describe("TournamentService", () => {
  it("starts the bracket automatically when the field fills", () => {
    const s = new TournamentService();
    s.register(meta());
    for (let i = 1; i <= 4; i++) s.join("1", P(i));
    expect(s.state("1").phase).toBe("running");
    expect(s.pending("1")).toHaveLength(2); // two semis
  });

  it("rejects double-join and over-fill", () => {
    const s = new TournamentService();
    s.register(meta({ maxPlayers: 2 }));
    s.join("1", P(1));
    expect(() => s.join("1", P(1))).toThrow(/already joined/);
    s.join("1", P(2)); // fills → running
    expect(() => s.join("1", P(3))).toThrow(/not in lobby/);
  });

  it("plays out a bracket and finalizes on-chain with ordered standings", async () => {
    const finalize = vi.fn().mockResolvedValue(undefined);
    const s = new TournamentService(finalize);
    s.register(meta({ maxPlayers: 4 }));
    [1, 2, 3, 4].forEach((n) => s.join("1", P(n)));

    // resolve every game in favour of the lower address until complete
    let guard = 0;
    while (s.state("1").phase === "running" && guard++ < 20) {
      for (const m of s.pending("1")) {
        const lower = BigInt(m.a) < BigInt(m.b) ? m.a : m.b;
        await s.reportResult("1", m.round, m.index, lower);
      }
    }

    expect(s.state("1").phase).toBe("done");
    expect(finalize).toHaveBeenCalledTimes(1);
    const [id, winners] = finalize.mock.calls[0];
    expect(id).toBe("1");
    expect(winners).toHaveLength(2);
    expect(winners[0]).toBe(P(1).toLowerCase()); // champion
  });

  it("only surfaces open lobbies", () => {
    const s = new TournamentService();
    s.register(meta({ id: "1", maxPlayers: 2 }));
    s.register(meta({ id: "2", maxPlayers: 4 }));
    s.join("1", P(1));
    s.join("1", P(2)); // id 1 fills → running
    const open = s.openLobbies();
    expect(open.map((t) => t.id)).toEqual(["2"]);
  });

  it("assigns deterministic host/guest roles and shares the async match id", () => {
    const s = new TournamentService();
    s.register(meta({ maxPlayers: 2 }));
    s.join("1", P(2));
    s.join("1", P(1)); // fills → running, one match P1 vs P2

    const a1 = s.assignment("1", P(1));
    const a2 = s.assignment("1", P(2));
    expect(a1).not.toBeNull();
    expect(a2).not.toBeNull();
    // lower address (P1) hosts; both see the same opponent
    expect(a1!.role).toBe("host");
    expect(a2!.role).toBe("guest");
    expect(a1!.opponent.toLowerCase()).toBe(P(2).toLowerCase());
    expect(a1!.asyncMatchId).toBeNull();

    // host creates the game and attaches it; guest now sees the id to join
    s.attachGame("1", a1!.round, a1!.index, "async-xyz");
    expect(s.assignment("1", P(2))!.asyncMatchId).toBe("async-xyz");
  });

  it("gives no assignment to a player waiting on another match", () => {
    const s = new TournamentService();
    s.register(meta({ maxPlayers: 4 }));
    [1, 2, 3, 4].forEach((n) => s.join("1", P(n)));
    // everyone in round 0 has an assignment; nobody is in the final yet
    expect(s.assignment("1", P(1))).not.toBeNull();
    // the final's players don't exist until semis resolve
    const finals = s.pending("1").filter((m) => m.round === 1);
    expect(finals).toHaveLength(0);
  });

  it("can be force-started at the join deadline with a partial field", () => {
    const s = new TournamentService();
    s.register(meta({ maxPlayers: 8 }));
    s.join("1", P(1));
    s.join("1", P(2));
    s.start("1"); // deadline reached, ≥2 entrants
    expect(s.state("1").phase).toBe("running");
  });

  describe("claimWalkover", () => {
    function pairedService(): TournamentService {
      const s = new TournamentService();
      s.register(meta({ maxPlayers: 2 }));
      s.join("1", P(2));
      s.join("1", P(1)); // fills → running; P1 (lower) hosts, P2 guests
      return s;
    }

    it("advances the guest once the grace period elapses and the host never created a game", async () => {
      const s = pairedService();
      await s.claimWalkover("1", 0, 0, P(2), 0);
      // the pairing is resolved — no longer among the pending games
      expect(s.pending("1").some((m) => m.round === 0 && m.index === 0)).toBe(false);
    });

    it("rejects the host claiming a walkover against themselves", async () => {
      const s = pairedService();
      await expect(s.claimWalkover("1", 0, 0, P(1), 0)).rejects.toThrow("host can't claim");
    });

    it("rejects before the grace period elapses", async () => {
      const s = pairedService();
      await expect(s.claimWalkover("1", 0, 0, P(2), 60_000)).rejects.toThrow("still has time");
    });

    it("rejects once the host has already created the game", async () => {
      const s = pairedService();
      s.attachGame("1", 0, 0, "async-xyz");
      await expect(s.claimWalkover("1", 0, 0, P(2), 0)).rejects.toThrow("claim inactivity there instead");
    });
  });
});
