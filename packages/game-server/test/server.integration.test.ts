import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { io as ioClient, type Socket } from "socket.io-client";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { GameHub } from "../src/hub.js";
import { attachSocketIO } from "../src/server.js";
import { moveDigest } from "../src/eip712.js";

const VERIFIER: Address = "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3";
const CHAIN_ID = 31337n;
const acct0 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000a11ce0");
const acct1 = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000b0b000");

let http: HttpServer;
let client: Socket;

afterEach(() => {
  client?.close();
  http?.close();
});

function start(hub: GameHub): Promise<number> {
  return new Promise((resolve) => {
    http = createServer();
    const server = new Server(http);
    attachSocketIO(server, { hub });
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
});
