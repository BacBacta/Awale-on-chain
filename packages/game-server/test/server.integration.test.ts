import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { io as ioClient, type Socket } from "socket.io-client";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { GameHub } from "../src/hub.js";
import { Matchmaker } from "../src/matchmaking.js";
import { attachSocketIO, type ServerDeps, type SocketHandle } from "../src/server.js";
import { InMemoryCashPairStore } from "../src/cash-pair-store.js";
import { moveDigest, resignDigest } from "../src/eip712.js";

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

/** Resolve once a socket is connected — robust to the socket already having
 *  connected before the handler is attached (a race that flakes under load:
 *  a plain `.on("connect")` never fires if connection already happened). */
function waitConnect(s: Socket): Promise<void> {
  return s.connected ? Promise.resolve() : new Promise((r) => s.once("connect", () => r()));
}

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

    it("rematch: two casual players who both offer are reunited in a NEW match directly (no lobby)", async () => {
      const hub = new GameHub();
      const port = await start(hub, { casualCtx: { chainId: CHAIN_ID, verifier: VERIFIER } });
      const { a, b, matchId } = await matchTwoCasualPlayers(port);
      client = a;
      client2 = b;
      a.emit("watch", { matchId });
      b.emit("watch", { matchId });
      await new Promise((r) => setTimeout(r, 30));

      // A offers a rematch; B is told, then accepts (also an offer) → new match
      const readyA = new Promise<{ matchId: string; role: 0 | 1 }>((res) => a.once("rematch-ready", res));
      const readyB = new Promise<{ matchId: string; role: 0 | 1 }>((res) => b.once("rematch-ready", res));
      const offered = new Promise<void>((res) => b.once("rematch-offered", () => res()));

      a.emit("rematch-offer", { matchId, address: acct0.address, mode: "casual", sessionPubKey: acct0.address });
      await offered; // B saw the offer
      b.emit("rematch-offer", { matchId, address: acct1.address, mode: "casual", sessionPubKey: acct1.address });

      const [ra, rb] = await Promise.all([readyA, readyB]);
      expect(ra.matchId).toBe(rb.matchId); // same NEW match
      expect(ra.matchId).not.toBe(matchId); // and it's a fresh one
      expect(new Set([ra.role, rb.role])).toEqual(new Set([0, 1]));
      expect(hub.get(BigInt(ra.matchId))).toBeDefined(); // opened and playable
    });

    it("P2-8: a queued player gets a queue-ack with the pool depth (for the adaptive AI fallback)", async () => {
      const hub = new GameHub();
      const port = await start(hub, { casualCtx: { chainId: CHAIN_ID, verifier: VERIFIER } });
      const a = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });
      client = a;
      // first player: empty pool ⇒ depth 0 ⇒ client will fall back fast
      const ack1 = await new Promise<{ depth: number }>((resolve) => {
        a.on("connect", () => a.emit("queue", { address: acct0.address, elo: 1000, mode: "casual", sessionPubKey: acct0.address }));
        a.once("queue-ack", resolve);
      });
      expect(ack1.depth).toBe(0);

      // a second, far-rated player can't pair (gap too big) → sees depth 1
      const b = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });
      client2 = b;
      const ack2 = await new Promise<{ depth: number }>((resolve) => {
        b.on("connect", () => b.emit("queue", { address: acct1.address, elo: 5000, mode: "casual", sessionPubKey: acct1.address }));
        b.once("queue-ack", resolve);
      });
      expect(ack2.depth).toBe(1); // one other waiter present
    });

    it("casual is untimed: an idle player never forfeits (Quick Match has no move-clock)", async () => {
      const hub = new GameHub();
      // a 50ms move-clock WOULD forfeit instantly if casual were timed — it isn't
      const port = await start(hub, { casualCtx: { chainId: CHAIN_ID, verifier: VERIFIER }, turnClockMs: 50 });
      const { a, b, matchId } = await matchTwoCasualPlayers(port);
      client = a;
      client2 = b;
      a.emit("watch", { matchId });
      b.emit("watch", { matchId });

      let over = false;
      a.on("gameover", () => (over = true));
      b.on("gameover", () => (over = true));
      // neither player moves for well past the would-be clock window
      await new Promise((r) => setTimeout(r, 400));
      expect(over).toBe(false); // no forfeit — casual has no time limit
      expect(hub.get(BigInt(matchId))).toBeDefined(); // match still live
    });

    it("casual: a resign ends the game and feeds the profile/Elo hook", async () => {
      const hub = new GameHub();
      const results: { players: [Address, Address]; winner: number }[] = [];
      const port = await start(hub, {
        casualCtx: { chainId: CHAIN_ID, verifier: VERIFIER },
        onResult: (players, winner) => results.push({ players, winner }),
      });
      const { a, b, matchId, roleA, roleB, turn } = await matchTwoCasualPlayers(port);
      client = a;
      client2 = b;
      a.emit("watch", { matchId });
      b.emit("watch", { matchId });
      await new Promise((r) => setTimeout(r, 20));

      // the player to move resigns → the opponent wins
      const resigner = turn === roleA ? a : b;
      const resignerAcct = turn === roleA ? acct0 : acct1;
      const expectedWinner = turn === roleA ? roleB : roleA;
      const sig = await resignerAcct.sign({ hash: resignDigest(BigInt(matchId), 0n, { chainId: CHAIN_ID, verifier: VERIFIER }) });

      const gameover = new Promise<{ winner: number }>((resolve) => a.once("gameover", resolve));
      resigner.emit("resign", { matchId, player: turn, signature: sig });
      const msg = await gameover;
      expect(msg.winner).toBe(expectedWinner);
      // both wallets + the winner reached the Elo/profile feed
      expect(results).toHaveLength(1);
      expect(results[0].winner).toBe(expectedWinner);
      expect(results[0].players.map((p) => p.toLowerCase()).sort()).toEqual(
        [acct0.address, acct1.address].map((p) => p.toLowerCase()).sort(),
      );
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
      await waitConnect(a);
      await waitConnect(b);
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
      await waitConnect(a);
      await waitConnect(b);
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

    it("v1 clients keep separate exact-stake buckets — different amounts never cross", async () => {
      const port = await start(new GameHub(), { eloOf: async () => 1200 });
      const [a, b] = connectQueued(port);
      client = a;
      client2 = b;
      let matched = false;
      a.on("cash-matched", () => (matched = true));
      b.on("cash-matched", () => (matched = true));
      await waitConnect(a);
      await waitConnect(b);
      // no `v` field = old client = exact-stake bucket
      a.emit("cash-queue", { address: acct0.address, stakeWei: "1000000000000000000", token: TOKEN });
      b.emit("cash-queue", { address: acct1.address, stakeWei: "2000000000000000000", token: TOKEN });
      await new Promise((r) => setTimeout(r, 80));
      lastHandle.sweepQueues();
      await new Promise((r) => setTimeout(r, 50));
      expect(matched).toBe(false); // different exact stakes never cross for old clients
    });

    it("P0-3: v2 clients pair across a stake band and BOTH settle at the lower stake", async () => {
      const port = await start(new GameHub(), { eloOf: async () => 1200, stakeDecimals: 18 });
      const [a, b] = connectQueued(port);
      client = a;
      client2 = b;
      const NINE = "900000000000000000"; // 0.9
      const TEN = "1000000000000000000"; // 1.0 — same "low" band as 0.9
      const mA = new Promise<{ role: string; stakeWei: string }>((r) => a.once("cash-matched", r));
      const mB = new Promise<{ role: string; stakeWei: string }>((r) => b.once("cash-matched", r));
      await waitConnect(a);
      await waitConnect(b);
      a.emit("cash-queue", { address: acct0.address, stakeWei: TEN, token: TOKEN, v: 2 });
      b.emit("cash-queue", { address: acct1.address, stakeWei: NINE, token: TOKEN, v: 2 });

      const [ra, rb] = await Promise.all([mA, mB]);
      expect(new Set([ra.role, rb.role])).toEqual(new Set(["create", "join"]));
      // both told to play for the LOWER stake, 0.9 — nobody risks more than asked
      expect(ra.stakeWei).toBe(NINE);
      expect(rb.stakeWei).toBe(NINE);
    });

    it("v2 clients do NOT cross a band boundary (0.9 low vs 5 mid)", async () => {
      const port = await start(new GameHub(), { eloOf: async () => 1200, stakeDecimals: 18 });
      const [a, b] = connectQueued(port);
      client = a;
      client2 = b;
      let matched = false;
      a.on("cash-matched", () => (matched = true));
      b.on("cash-matched", () => (matched = true));
      await waitConnect(a);
      await waitConnect(b);
      a.emit("cash-queue", { address: acct0.address, stakeWei: "900000000000000000", token: TOKEN, v: 2 }); // low
      b.emit("cash-queue", { address: acct1.address, stakeWei: "5000000000000000000", token: TOKEN, v: 2 }); // mid
      await new Promise((r) => setTimeout(r, 80));
      lastHandle.sweepQueues();
      await new Promise((r) => setTimeout(r, 50));
      expect(matched).toBe(false); // different bands = different pools
    });

    it("P1-6: the ranked pool is strict — a fresh player isn't dragged into a waiting veteran's huge window", async () => {
      let clock = 0;
      const elos: Record<string, number> = { [acct0.address.toLowerCase()]: 1000, [acct1.address.toLowerCase()]: 1400 };
      const port = await start(new GameHub(), {
        casualCtx: { chainId: CHAIN_ID, verifier: VERIFIER },
        eloOf: async (a) => elos[a.toLowerCase()] ?? null,
        rankedMatchmaking: { baseWindow: 100, windowGrowthPerSec: 10, now: () => clock },
      });
      const [a, b] = connectQueued(port);
      client = a;
      client2 = b;
      let matched = false;
      a.on("matched", () => (matched = true));
      b.on("matched", () => (matched = true));
      await waitConnect(a);
      await waitConnect(b);
      // veteran queues ranked, waits; window widens to cover 400
      a.emit("queue", { address: acct0.address, elo: 1000, mode: "ranked", sessionPubKey: acct0.address });
      await new Promise((r) => setTimeout(r, 40));
      clock = 60_000;
      // fresh arrival 400 away: veteran's window covers it, the newcomer's does not
      b.emit("queue", { address: acct1.address, elo: 1400, mode: "ranked", sessionPubKey: acct1.address });
      await new Promise((r) => setTimeout(r, 40));
      lastHandle.sweepQueues();
      await new Promise((r) => setTimeout(r, 40));
      expect(matched).toBe(false); // strict pool protects the fresh player
    });

    it("P1-4: a half-built cash pair persisted before a restart is aborted, and the creator is told to reclaim it", async () => {
      const store = new InMemoryCashPairStore();
      // simulate the state the previous process left behind: creator staked,
      // match #77 created on-chain, then the server died
      await store.put({
        creator: acct0.address,
        joiner: acct1.address,
        stakeKey: `${TOKEN}:1000000000000000000`,
        matchId: "77",
        createdAt: 1,
      });

      // "restart": a fresh server sharing the same store, then boot recovery
      const port = await start(new GameHub(), { eloOf: async () => 1200, cashPairStore: store });
      const recovered = await lastHandle.recoverCashPairs();
      expect(recovered).toBe(1);
      expect(await store.list()).toHaveLength(0); // cleared — no repeat next boot

      // the creator reconnects and tries to queue again → gets the abort with a
      // reason pointing at the match to cancel for a refund
      const a = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });
      client = a;
      const abort = new Promise<{ reason: string }>((r) => a.once("cash-abort", r));
      await waitConnect(a);
      a.emit("cash-queue", { address: acct0.address, stakeWei: "1000000000000000000", token: TOKEN, v: 2 });
      const msg = await abort;
      expect(msg.reason).toMatch(/restart/i);
      expect(msg.reason).toMatch(/Your matches|reclaim|cancel/i);
    });
  });
});
