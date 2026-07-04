import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { io as ioClient, type Socket } from "socket.io-client";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { GameHub } from "../src/hub.js";
import { Matchmaker } from "../src/matchmaking.js";
import { attachSocketIO, type ServerDeps, type SocketHandle } from "../src/server.js";
import { moveDigest } from "../src/eip712.js";

const VERIFIER: Address = "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3";
const CHAIN_ID = 31337n;
const acct0 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000a11ce0");
const acct1 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000b0b000");

let http: HttpServer;
let client: Socket;
let client2: Socket;

afterEach(() => {
  client?.close();
  client2?.close();
  http?.close();
});

let lastHandle: SocketHandle;
function start(hub: GameHub, extra: Partial<ServerDeps> = {}): Promise<number> {
  return new Promise((resolve) => {
    http = createServer();
    const server = new Server(http);
    lastHandle = attachSocketIO(server, { hub, ...extra });
    http.listen(0, () => resolve((http.address() as { port: number }).port));
  });
}

describe("Socket.IO transport (integration)", () => {
  it("watches a match, applies a signed move, and broadcasts the new state", async () => {
    const hub = new GameHub();
    hub.open({
      matchId: 1n,
      chainId: CHAIN_ID,
      verifier: VERIFIER,
      sessions: [acct0.address, acct1.address],
      startTurn: 0,
    });
    const port = await start(hub);

    client = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });

    // first state (after watch)
    const initial = await new Promise<{ state: { turn: number; over: boolean } }>((resolve) => {
      client.on("connect", () => client.emit("watch", { matchId: "1" }));
      client.once("state", resolve);
    });
    expect(initial.state.turn).toBe(0);
    expect(initial.state.over).toBe(false);

    // player 0 plays house 0, signed with its session key
    const house = 0;
    const sig = await acct0.sign({ hash: moveDigest(1n, 0n, house, { chainId: CHAIN_ID, verifier: VERIFIER }) });

    const next = await new Promise<{ state: { turn: number } }>((resolve) => {
      client.once("state", resolve);
      client.emit("move", { matchId: "1", player: 0, house, signature: sig });
    });
    expect(next.state.turn).toBe(1); // turn passed to player 1
  });

  it("rejects a move with a bad signature", async () => {
    const hub = new GameHub();
    hub.open({
      matchId: 2n,
      chainId: CHAIN_ID,
      verifier: VERIFIER,
      sessions: [acct0.address, acct1.address],
      startTurn: 0,
    });
    const port = await start(hub);
    client = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });

    await new Promise<void>((resolve) => client.on("connect", () => resolve()));
    client.emit("watch", { matchId: "2" });

    // player 0's move signed by player 1's key -> rejected
    const badSig = await acct1.sign({ hash: moveDigest(2n, 0n, 0, { chainId: CHAIN_ID, verifier: VERIFIER }) });
    const err = await new Promise<{ message: string }>((resolve) => {
      client.once("error", resolve);
      client.emit("move", { matchId: "2", player: 0, house: 0, signature: badSig });
    });
    expect(err.message).toMatch(/bad move signature/);
  });

  describe("move-clock", () => {
    async function matchTwoCasualPlayers(
      port: number,
    ): Promise<{ a: Socket; b: Socket; matchId: string; roleA: 0 | 1; roleB: 0 | 1; turn: 0 | 1 }> {
      const a = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });
      const b = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });
      await Promise.all([
        new Promise<void>((resolve) => a.on("connect", () => resolve())),
        new Promise<void>((resolve) => b.on("connect", () => resolve())),
      ]);
      const matchedA = new Promise<{ matchId: string; role: 0 | 1 }>((resolve) => a.once("matched", resolve));
      const matchedB = new Promise<{ matchId: string; role: 0 | 1 }>((resolve) => b.once("matched", resolve));
      const stateA = new Promise<{ state: { turn: 0 | 1 } }>((resolve) => a.once("state", resolve));
      a.emit("queue", { address: acct0.address, elo: 1000, mode: "casual", sessionPubKey: acct0.address });
      b.emit("queue", { address: acct1.address, elo: 1000, mode: "casual", sessionPubKey: acct1.address });
      const [ma, mb, sa] = await Promise.all([matchedA, matchedB, stateA]);
      return { a, b, matchId: ma.matchId, roleA: ma.role, roleB: mb.role, turn: sa.state.turn };
    }

    it("P0-1: two queued sockets get matched by the periodic sweep — no third joiner", async () => {
      // Injected clock so the window widens on demand, not on wall time.
      let clock = 0;
      const mm = new Matchmaker({ baseWindow: 100, windowGrowthPerSec: 10, now: () => clock });
      const hub = new GameHub(mm);
      const port = await start(hub, { casualCtx: { chainId: CHAIN_ID, verifier: VERIFIER } });

      const a = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });
      const b = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });
      client = a;
      client2 = b;

      const matchedA = new Promise<{ matchId: string; role: 0 | 1 }>((resolve) => a.once("matched", resolve));
      const matchedB = new Promise<{ matchId: string; role: 0 | 1 }>((resolve) => b.once("matched", resolve));

      // both enqueue 300 Elo apart: gap 300 > base window 100, so neither
      // pairs on enqueue — they sit in the queue (the exact bug P0-1 fixes)
      await new Promise<void>((resolve) => a.on("connect", () => resolve()));
      await new Promise<void>((resolve) => b.on("connect", () => resolve()));
      a.emit("queue", { address: acct0.address, elo: 1000, mode: "casual", sessionPubKey: acct0.address });
      b.emit("queue", { address: acct1.address, elo: 1300, mode: "casual", sessionPubKey: acct1.address });
      await new Promise((r) => setTimeout(r, 50)); // let both enqueues land
      expect(hub.matchmaker.queueSize).toBe(2); // nobody matched yet

      // 30s later the windows overlap; the sweep the runner would fire pairs them
      clock = 30_000;
      lastHandle.sweepQueues();

      const [ma, mb] = await Promise.all([matchedA, matchedB]);
      expect(ma.matchId).toBe(mb.matchId); // same off-chain match, roles assigned
      expect(new Set([ma.role, mb.role])).toEqual(new Set([0, 1]));
      expect(hub.matchmaker.queueSize).toBe(0);
    });

    it("casual: forfeits whoever's turn-clock expires, opponent wins, result reaches the profile hook", async () => {
      const hub = new GameHub();
      const results: { players: [Address, Address]; winner: number }[] = [];
      const port = await start(hub, {
        casualCtx: { chainId: CHAIN_ID, verifier: VERIFIER },
        turnClockMs: 50,
        onResult: (players, winner) => results.push({ players, winner }),
      });
      const { a, b, matchId, roleA, roleB, turn } = await matchTwoCasualPlayers(port);
      client = a;
      client2 = b;
      a.emit("watch", { matchId });
      b.emit("watch", { matchId });

      const mover = turn === roleA ? a : b;
      const waiter = turn === roleA ? b : a;
      const expectedWinner = turn === roleA ? roleB : roleA;
      void mover; // never plays — lets its clock run out

      const gameover = new Promise<{ winner: number }>((resolve) => waiter.once("gameover", resolve));
      const msg = await gameover;
      expect(msg.winner).toBe(expectedWinner);
      expect(hub.get(BigInt(matchId))).toBeUndefined(); // closed after the forfeit
      // both wallet addresses + the winner made it to the Elo/profile feed
      expect(results).toHaveLength(1);
      expect(results[0].winner).toBe(expectedWinner);
      expect(results[0].players.map((p) => p.toLowerCase()).sort()).toEqual(
        [acct0.address, acct1.address].map((p) => p.toLowerCase()).sort(),
      );
    });

    it("casual: a timely move hands the clock to the next mover, not a re-forfeit of the one who just played", async () => {
      const hub = new GameHub();
      const port = await start(hub, { casualCtx: { chainId: CHAIN_ID, verifier: VERIFIER }, turnClockMs: 80 });
      const { a, b, matchId, roleA, roleB, turn } = await matchTwoCasualPlayers(port);
      client = a;
      client2 = b;
      a.emit("watch", { matchId });
      b.emit("watch", { matchId });

      const mover = turn === roleA ? a : b;
      const moverRole = turn === roleA ? roleA : roleB;
      const house = hub.get(BigInt(matchId))!.legalMoves()[0];
      const sig = await (turn === roleA ? acct0 : acct1).sign({
        hash: moveDigest(BigInt(matchId), 0n, house, { chainId: CHAIN_ID, verifier: VERIFIER }),
      });

      const gameover = new Promise<{ winner: number }>((resolve) => a.once("gameover", resolve));
      mover.emit("move", { matchId, player: turn, house, signature: sig });

      // neither player moves again: whoever's turn it is *now* (the other
      // player) should be the one whose clock expires — proving the timer
      // followed the turn instead of re-punishing the player who just moved.
      const msg = await gameover;
      expect(msg.winner).toBe(moverRole);
    });

    it("staked timeout: forfeits into game-over (two-signature fast path), with claim-eligible only as the watchdog fallback", async () => {
      const hub = new GameHub();
      // a real (non-casual) matchId — no bit-200 flag, exactly like an on-chain escrow id
      hub.open({ matchId: 42n, chainId: CHAIN_ID, verifier: VERIFIER, sessions: [acct0.address, acct1.address], startTurn: 0 });
      // short move-clock, but a long watchdog so we can prove game-over comes
      // FIRST (the instant settle path) and claim-eligible is only the fallback
      const port = await start(hub, { turnClockMs: 50, unsettledWatchdogMs: 5000 });
      client = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });

      const gameover = new Promise<{ winner: number }>((resolve) => client.once("gameover", resolve));
      let claimFired = false;
      client.on("claim-eligible", () => (claimFired = true));
      client.on("connect", () => client.emit("watch", { matchId: "42" }));

      const msg = await gameover;
      expect(msg.winner).toBe(1); // player 0 (turn 0) never moved — player 1 wins
      expect(hub.get(42n)?.over).toBe(true); // forfeited — a real, settleable result
      // game-over fired well before the 5s watchdog: no premature claim-eligible
      expect(claimFired).toBe(false);
    });
  });

  describe("cash matchmaking (P0-2: skill-aware pairing)", () => {
    const TOKEN: Address = "0x1111111111111111111111111111111111111111";
    const STAKE = "1000000000000000000"; // 1 token

    function connectQueued(port: number): [Socket, Socket] {
      const a = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });
      const b = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });
      return [a, b];
    }

    it("pairs two close-rated players in the same stake bucket immediately", async () => {
      const elos: Record<string, number> = { [acct0.address.toLowerCase()]: 1200, [acct1.address.toLowerCase()]: 1210 };
      const port = await start(new GameHub(), { eloOf: async (a) => elos[a.toLowerCase()] ?? null });
      const [a, b] = connectQueued(port);
      client = a;
      client2 = b;

      const mA = new Promise<{ role: string; stakeWei: string }>((r) => a.once("cash-matched", r));
      const mB = new Promise<{ role: string; stakeWei: string }>((r) => b.once("cash-matched", r));
      await new Promise<void>((r) => a.on("connect", () => r()));
      await new Promise<void>((r) => b.on("connect", () => r()));
      a.emit("cash-queue", { address: acct0.address, stakeWei: STAKE, token: TOKEN });
      b.emit("cash-queue", { address: acct1.address, stakeWei: STAKE, token: TOKEN });

      const [ra, rb] = await Promise.all([mA, mB]);
      expect(new Set([ra.role, rb.role])).toEqual(new Set(["create", "join"]));
      expect(ra.stakeWei).toBe(STAKE);
    });

    it("does NOT pair a novice with a shark inside the base window, but DOES after the liquidity backstop", async () => {
      let clock = 0;
      const elos: Record<string, number> = { [acct0.address.toLowerCase()]: 1200, [acct1.address.toLowerCase()]: 2000 };
      const port = await start(new GameHub(), {
        eloOf: async (a) => elos[a.toLowerCase()] ?? null,
        // growth 0 so only the backstop can bridge the 800-gap — deterministic
        cashMatchmaking: { baseWindow: 200, windowGrowthPerSec: 0, pairAnyoneAfterSec: 120, now: () => clock },
      });
      const [a, b] = connectQueued(port);
      client = a;
      client2 = b;

      let matched = false;
      a.on("cash-matched", () => (matched = true));
      b.on("cash-matched", () => (matched = true));
      await new Promise<void>((r) => a.on("connect", () => r()));
      await new Promise<void>((r) => b.on("connect", () => r()));
      a.emit("cash-queue", { address: acct0.address, stakeWei: STAKE, token: TOKEN });
      b.emit("cash-queue", { address: acct1.address, stakeWei: STAKE, token: TOKEN });
      await new Promise((r) => setTimeout(r, 80));
      lastHandle.sweepQueues();
      await new Promise((r) => setTimeout(r, 50));
      expect(matched).toBe(false); // 800 Elo apart, inside base window: never for money

      // wait out the liquidity backstop — now a game beats no game
      const mA = new Promise<{ role: string }>((r) => a.once("cash-matched", r));
      const mB = new Promise<{ role: string }>((r) => b.once("cash-matched", r));
      clock = 120_000;
      lastHandle.sweepQueues();
      const [ra, rb] = await Promise.all([mA, mB]);
      expect(new Set([ra.role, rb.role])).toEqual(new Set(["create", "join"]));
    });

    it("keeps separate buckets per stake — different amounts never cross", async () => {
      const port = await start(new GameHub(), { eloOf: async () => 1200 });
      const [a, b] = connectQueued(port);
      client = a;
      client2 = b;
      let matched = false;
      a.on("cash-matched", () => (matched = true));
      b.on("cash-matched", () => (matched = true));
      await new Promise<void>((r) => a.on("connect", () => r()));
      await new Promise<void>((r) => b.on("connect", () => r()));
      a.emit("cash-queue", { address: acct0.address, stakeWei: "1000000000000000000", token: TOKEN });
      b.emit("cash-queue", { address: acct1.address, stakeWei: "2000000000000000000", token: TOKEN });
      await new Promise((r) => setTimeout(r, 80));
      lastHandle.sweepQueues();
      await new Promise((r) => setTimeout(r, 50));
      expect(matched).toBe(false); // different exact stakes = different pools (until P0-3 bands)
    });
  });
});
