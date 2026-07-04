import { describe, it, expect } from "vitest";
import { buildLobby, LobbyService, type RawOpenMatch } from "../src/lobby-service.js";
import type { Address } from "viem";

const TOKEN: Address = "0x1111111111111111111111111111111111111111";
const TOKEN2: Address = "0x2222222222222222222222222222222222222222";
const ALICE: Address = "0x00000000000000000000000000000000000000a1";
const BOB: Address = "0x00000000000000000000000000000000000000b0";
const CARA: Address = "0x00000000000000000000000000000000000000ca";

const m = (id: number, creator: Address, stake = 1000n, token = TOKEN): RawOpenMatch => ({
  id: BigInt(id),
  stake,
  token,
  creator,
  rakeBps: 800,
});

describe("lobby buildLobby (P2-8)", () => {
  it("lists others' matches newest-first and separates the viewer's own", () => {
    const raw = [m(1, BOB), m(3, ALICE), m(2, CARA)];
    const snap = buildLobby(raw, ALICE);
    expect(snap.matches.map((x) => x.id)).toEqual(["2", "1"]); // BOB/CARA, newest first
    expect(snap.matches.every((x) => !x.mine)).toBe(true);
    expect(snap.mine.map((x) => x.id)).toEqual(["3"]);
    expect(snap.mine[0].mine).toBe(true);
  });

  it("with no viewer, every open match is listed (none mine)", () => {
    const snap = buildLobby([m(1, BOB), m(2, CARA)]);
    expect(snap.matches).toHaveLength(2);
    expect(snap.mine).toHaveLength(0);
    expect(snap.convergeTo).toBeNull();
  });

  it("converges the viewer to the OLDEST equal-stake match owned by someone else", () => {
    // Bob opened #1 at stake 1000, Cara #2 at 1000, Alice #5 at 1000.
    // Alice should be told to join the OLDEST (#1), not wait in her own room.
    const raw = [m(1, BOB, 1000n), m(2, CARA, 1000n), m(5, ALICE, 1000n)];
    expect(buildLobby(raw, ALICE).convergeTo).toBe("1");
  });

  it("does not converge across different stakes or tokens", () => {
    const raw = [
      m(1, BOB, 2000n), // different stake
      m(2, CARA, 1000n, TOKEN2), // different token
      m(5, ALICE, 1000n, TOKEN),
    ];
    expect(buildLobby(raw, ALICE).convergeTo).toBeNull();
  });

  it("does not converge to a NEWER match than the viewer's own", () => {
    // Alice's #2 is older than Bob's #5 at the same stake → she keeps hers
    const raw = [m(2, ALICE, 1000n), m(5, BOB, 1000n)];
    expect(buildLobby(raw, ALICE).convergeTo).toBeNull();
  });

  it("serializes bigints as strings", () => {
    const snap = buildLobby([m(1, BOB, 1234n)], ALICE);
    expect(snap.matches[0].stake).toBe("1234");
    expect(typeof snap.matches[0].id).toBe("string");
  });
});

describe("LobbyService cache", () => {
  it("serves the cached scan and reports staleness", async () => {
    let clock = 0;
    let scanCount = 0;
    const svc = new LobbyService(async () => {
      scanCount++;
      return [m(1, BOB)];
    }, () => clock);
    await svc.refresh();
    clock = 5000;
    const snap = svc.snapshot(ALICE);
    expect(snap.matches).toHaveLength(1);
    expect(snap.ageMs).toBe(5000);
    expect(scanCount).toBe(1); // snapshot doesn't re-scan
  });

  it("refreshSafe keeps the last good cache when a scan throws", async () => {
    let fail = false;
    const svc = new LobbyService(async () => {
      if (fail) throw new Error("rpc down");
      return [m(1, BOB)];
    });
    await svc.refreshSafe();
    fail = true;
    await svc.refreshSafe(); // must not throw, must not clear
    expect(svc.snapshot().matches).toHaveLength(1);
  });
});
