import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { io as ioClient, type Socket } from "socket.io-client";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { GameHub } from "../src/hub.js";
import { attachSocketIO, type ServerDeps } from "../src/server.js";
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

function start(hub: GameHub, extra: Partial<ServerDeps> = {}): Promise<number> {
  return new Promise((resolve) => {
    http = createServer();
    const server = new Server(http);
    attachSocketIO(server, { hub, ...extra });
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

    it("casual: forfeits whoever's turn-clock expires, opponent wins", async () => {
      const hub = new GameHub();
      const port = await start(hub, { casualCtx: { chainId: CHAIN_ID, verifier: VERIFIER }, turnClockMs: 50 });
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

    it("staked: signals claim-eligible instead of an unsigned forfeit", async () => {
      const hub = new GameHub();
      // a real (non-casual) matchId — no bit-200 flag, exactly like an on-chain escrow id
      hub.open({ matchId: 42n, chainId: CHAIN_ID, verifier: VERIFIER, sessions: [acct0.address, acct1.address], startTurn: 0 });
      const port = await start(hub, { turnClockMs: 50 });
      client = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });

      const claim = new Promise<{ matchId: string; winner: number; transcript: unknown }>((resolve) =>
        client.once("claim-eligible", resolve),
      );
      client.on("connect", () => client.emit("watch", { matchId: "42" }));
      const noGameover = new Promise<void>((resolve) => {
        client.once("gameover", () => resolve());
        setTimeout(resolve, 200);
      });

      const msg = await claim;
      expect(msg.winner).toBe(1); // player 0 (turn 0) never moved — player 1 wins the claim
      expect(msg.transcript).toBeDefined();
      await noGameover;
      // the hub never unilaterally decided the outcome — no signature was ever given
      expect(hub.get(42n)?.over).toBe(false);
    });
  });
});
