// Runnable game server: ties the tested pieces (GameHub, on-chain listener,
// Socket.IO transport, settlement client) to a live deployment.
//
// Env (see .env.example): RPC_URL, CHAIN_ID, ESCROW_ADDRESS, VERIFIER_ADDRESS,
// PORT, SERVER_SIGNER_KEY (optional), FEE_CURRENCY (optional), SELF_SCOPE,
// SELF_ENDPOINT, SELF_MOCK_PASSPORT (optional).

import { createServer } from "node:http";
import { Server } from "socket.io";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { celo, celoSepolia, celoAlfajores } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { GameHub } from "./hub.js";
import { attachSocketIO } from "./server.js";
import { watchMatchJoined, watchStartFinalized, type ChainMatch, type EventWatcher } from "./listener.js";
import { SettlementClient } from "./chain.js";
import { SettlementCoordinator } from "./settlement-coordinator.js";
import { keeperActions, runKeeper, EscrowStatus, type KeeperMatch } from "./keeper.js";
import { AsyncMatchService } from "./async-match.js";
import { InMemoryMatchStore } from "./persistence/store.js";
import { InMemorySubscriptionStore, LogNotifier, WebPushNotifier, type Notifier, type WebPushSubscription } from "./notifications/notifier.js";
import { matchEscrowAbi } from "../../protocol/src/abis.js";
import { SelfPersonhoodVerifier } from "./personhood/self-verifier.js";
import { InMemoryPersonhoodRegistry } from "./personhood/registry.js";
import { verifyAndRegister } from "./personhood/gate.js";
import type { PersonhoodRegistry } from "./personhood/types.js";

const RPC_URL = required("RPC_URL");
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "11142220");
const ESCROW = required("ESCROW_ADDRESS") as Address;
const VERIFIER = required("VERIFIER_ADDRESS") as Address;
const PORT = Number(process.env.PORT ?? "8080");
const SIGNER = process.env.SERVER_SIGNER_KEY;
const FEE_CURRENCY = (process.env.FEE_CURRENCY || undefined) as Address | undefined;
const KEEPER_INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? "30000");

// Match ids the server has seen join, polled by the keeper for time-based
// actions (finalize proposed results, void expired matches). Terminal matches
// are pruned.
const tracked = new Set<string>();

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

// optional: Self proof-of-personhood gating for ranked/cash play
const SELF_SCOPE = process.env.SELF_SCOPE;
const SELF_ENDPOINT = process.env.SELF_ENDPOINT;
const personhood: PersonhoodRegistry = new InMemoryPersonhoodRegistry();
const selfVerifier = SELF_SCOPE && SELF_ENDPOINT
  ? new SelfPersonhoodVerifier({
      scope: SELF_SCOPE,
      endpoint: SELF_ENDPOINT,
      mockPassport: process.env.SELF_MOCK_PASSPORT !== "false",
    })
  : undefined;

// Async / correspondence play + push (scaffold; in-memory store + log notifier
// by default — swap for Redis/Postgres + web-push, see docs/async-push-milestone.md).
const subStore = new InMemorySubscriptionStore();
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const notifier: Notifier =
  VAPID_PUBLIC && VAPID_PRIVATE
    ? new WebPushNotifier(subStore, { publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE, subject: process.env.VAPID_SUBJECT ?? "mailto:ops@awale.app" })
    : new LogNotifier();
const asyncMatches = new AsyncMatchService(new InMemoryMatchStore(), notifier);

function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (code: number, payload: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(payload));
  };

  // --- async / correspondence play ---
  if (req.method === "GET" && url.pathname === "/async/matches") {
    const address = url.searchParams.get("address") as Address | null;
    if (!address) return json(400, { error: "address required" });
    asyncMatches.listForPlayer(address).then((m) => json(200, { matches: m })).catch((e) => json(500, { error: (e as Error).message }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/async/match") {
    const id = url.searchParams.get("id");
    if (!id) return json(400, { error: "id required" });
    asyncMatches.getState(id).then((s) => (s ? json(200, s) : json(404, { error: "not found" }))).catch((e) => json(500, { error: (e as Error).message }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/async/move") {
    readJson(req)
      .then((b) => {
        const { matchId, player, house, signature } = b as { matchId: string; player: 0 | 1; house: number; signature: `0x${string}` };
        return asyncMatches.move(matchId, player, house, signature);
      })
      .then((state) => json(200, { state }))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/push/subscribe") {
    readJson(req)
      .then((b) => {
        const { address, subscription } = b as { address: Address; subscription: WebPushSubscription };
        if (!address || !subscription?.endpoint) throw new Error("address + subscription required");
        return subStore.add(address, subscription);
      })
      .then(() => json(200, { ok: true }))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }

  if (req.method === "POST" && req.url === "/self/verify") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        if (!selfVerifier) throw new Error("personhood verification not configured");
        const { address, ...proof } = JSON.parse(body) as { address: Address };
        const out = await verifyAndRegister(selfVerifier, personhood, address, proof);
        res.writeHead(out.verified ? 200 : 400, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ verified: false, reason: (err as Error).message }));
      }
    });
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, activeMatches: hub.activeCount, chainId: CHAIN_ID }));
});
const io = new Server(httpServer, { cors: { origin: "*" } });

const coordinator = new SettlementCoordinator({ escrow: ESCROW, chainId: BigInt(CHAIN_ID), settlement });

attachSocketIO(io, {
  hub,
  coordinator,
  personhood: selfVerifier ? personhood : undefined,
  casualCtx: { chainId: BigInt(CHAIN_ID), verifier: VERIFIER },
  onGameOver: (matchId, winner) => {
    console.log(`[match ${matchId}] over, winner=${winner} — awaiting result signatures`);
  },
});

// First-move randomness lifecycle:
//  - on MatchJoined, fix the deferred flip by calling finalizeStart (needs a
//    signer; it reverts harmlessly if the reveal block isn't mined yet, so the
//    keeper retries any that are missed);
//  - on StartFinalized, open the match in the hub for play.
if (settlement) {
  watchMatchJoined(publicClient as unknown as EventWatcher, {
    escrow: ESCROW,
    finalize: async (matchId) => {
      tracked.add(matchId.toString()); // keeper now watches this match's lifecycle
      try {
        await settlement!.finalizeStart(matchId);
      } catch {
        /* too early or already fixed — the keeper will retry if needed */
      }
    },
  });
}

// Keeper loop: finalize proposed results past their challenge window, fix the
// first move when its reveal block is mined, and void matches that expired.
async function keeperTick(): Promise<void> {
  if (!settlement || tracked.size === 0) return;
  let blockNumber = 0;
  try {
    blockNumber = Number(await publicClient.getBlockNumber());
  } catch {
    /* fall back to 0 — finalizeStart simply won't be emitted this tick */
  }
  const now = Math.floor(Date.now() / 1000);
  const matches: KeeperMatch[] = [];
  for (const idStr of tracked) {
    try {
      const m = (await publicClient.readContract({
        address: ESCROW,
        abi: matchEscrowAbi,
        functionName: "getMatch",
        args: [BigInt(idStr)],
      })) as { status: number; startTurn: number; challengeDeadline: bigint; activeDeadline: bigint; revealBlock: bigint };
      const status = Number(m.status);
      if (status === EscrowStatus.Resolved || status === EscrowStatus.Voided || status === EscrowStatus.Cancelled) {
        tracked.delete(idStr); // terminal — stop watching
        continue;
      }
      matches.push({
        matchId: BigInt(idStr),
        status,
        startTurn: Number(m.startTurn),
        challengeDeadline: Number(m.challengeDeadline),
        activeDeadline: Number(m.activeDeadline),
        revealBlock: Number(m.revealBlock),
      });
    } catch {
      /* transient RPC error — retry next tick */
    }
  }
  const actions = keeperActions(matches, now, blockNumber);
  if (actions.length === 0) return;
  try {
    await runKeeper(settlement, actions);
    for (const a of actions) console.log(`[keeper] ${a.action} match ${a.matchId}`);
  } catch (err) {
    console.warn(`[keeper] action failed: ${(err as Error).message}`);
  }
}

if (settlement) {
  const t = setInterval(() => void keeperTick(), KEEPER_INTERVAL_MS);
  if ("unref" in t) t.unref();
}
watchStartFinalized(
  publicClient as unknown as EventWatcher,
  { escrow: ESCROW, ctx: { chainId: BigInt(CHAIN_ID), verifier: VERIFIER }, readMatch },
  hub,
);

httpServer.listen(PORT, () => {
  console.log(`Awalé game server on :${PORT} — chain ${CHAIN_ID}, escrow ${ESCROW}`);
  console.log(`settlement signer: ${settlement ? "configured" : "not set (read-only)"}`);
  console.log(`Self personhood gate: ${selfVerifier ? "enabled" : "disabled (ranked/cash ungated)"}`);
});
