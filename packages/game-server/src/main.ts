// Runnable game server: ties the tested pieces (GameHub, on-chain listener,
// Socket.IO transport, settlement client) to a live deployment.
//
// Env (see .env.example): RPC_URL, CHAIN_ID, ESCROW_ADDRESS, VERIFIER_ADDRESS,
// PORT, SERVER_SIGNER_KEY (optional), FEE_CURRENCY (optional).

import { createServer } from "node:http";
import { Server } from "socket.io";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { celo, celoSepolia, celoAlfajores } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { GameHub } from "./hub.js";
import { attachSocketIO } from "./server.js";
import { watchMatchJoined, type ChainMatch, type EventWatcher } from "./listener.js";
import { SettlementClient } from "./chain.js";
import { SettlementCoordinator } from "./settlement-coordinator.js";
import { matchEscrowAbi } from "../../protocol/src/abis.js";

const RPC_URL = required("RPC_URL");
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "11142220");
const ESCROW = required("ESCROW_ADDRESS") as Address;
const VERIFIER = required("VERIFIER_ADDRESS") as Address;
const PORT = Number(process.env.PORT ?? "8080");
const SIGNER = process.env.SERVER_SIGNER_KEY;
const FEE_CURRENCY = (process.env.FEE_CURRENCY || undefined) as Address | undefined;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function chainFor(id: number) {
  if (id === celoSepolia.id) return celoSepolia;
  if (id === celoAlfajores.id) return celoAlfajores;
  return celo;
}

const publicClient = createPublicClient({ chain: chainFor(CHAIN_ID), transport: http(RPC_URL) });
const hub = new GameHub();

/** Read an on-chain match into the hub's ChainMatch shape. */
async function readMatch(matchId: bigint): Promise<ChainMatch> {
  const m = (await publicClient.readContract({
    address: ESCROW,
    abi: matchEscrowAbi,
    functionName: "getMatch",
    args: [matchId],
  })) as { session0: Address; session1: Address; startTurn: number };
  return { matchId, session0: m.session0, session1: m.session1, startTurn: Number(m.startTurn) };
}

// optional: a funded signer lets the server submit settlements
let settlement: SettlementClient | undefined;
if (SIGNER && SIGNER.startsWith("0x") && SIGNER.length === 66) {
  settlement = new SettlementClient({
    rpcUrl: RPC_URL,
    escrow: ESCROW,
    account: privateKeyToAccount(SIGNER as Hex),
    feeCurrency: FEE_CURRENCY,
  });
}

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, activeMatches: hub.activeCount, chainId: CHAIN_ID }));
});
const io = new Server(httpServer, { cors: { origin: "*" } });

const coordinator = new SettlementCoordinator({ escrow: ESCROW, chainId: BigInt(CHAIN_ID), settlement });

attachSocketIO(io, {
  hub,
  coordinator,
  onGameOver: (matchId, winner) => {
    console.log(`[match ${matchId}] over, winner=${winner} — awaiting result signatures`);
  },
});

// open matches in the hub as they go Active on-chain
watchMatchJoined(
  publicClient as unknown as EventWatcher,
  { escrow: ESCROW, ctx: { chainId: BigInt(CHAIN_ID), verifier: VERIFIER }, readMatch },
  hub,
);

httpServer.listen(PORT, () => {
  console.log(`Awalé game server on :${PORT} — chain ${CHAIN_ID}, escrow ${ESCROW}`);
  console.log(`settlement signer: ${settlement ? "configured" : "not set (read-only)"}`);
});
