// Runnable game server: ties the tested pieces (GameHub, on-chain listener,
// Socket.IO transport, settlement client) to a live deployment.
//
// Env (see .env.example): RPC_URL, CHAIN_ID, ESCROW_ADDRESS, VERIFIER_ADDRESS,
// PORT, SERVER_SIGNER_KEY (optional), FEE_CURRENCY (optional), SELF_SCOPE,
// SELF_ENDPOINT, SELF_MOCK_PASSPORT (optional).

import { createServer } from "node:http";
import { Server } from "socket.io";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { celo, celoSepolia, celoAlfajores } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { GameHub } from "./hub.js";
import { attachSocketIO } from "./server.js";
import { watchMatchJoined, watchStartFinalized, type ChainMatch, type EventWatcher } from "./listener.js";
import { SettlementClient } from "./chain.js";
import { SettlementCoordinator } from "./settlement-coordinator.js";
import { keeperActions, runKeeper, EscrowStatus, type KeeperMatch } from "./keeper.js";
import { AsyncMatchService } from "./async-match.js";
import { InMemoryMatchStore, type MatchStore } from "./persistence/store.js";
import { RedisMatchStore } from "./persistence/redis-store.js";
import IORedis from "ioredis";
import { InMemorySubscriptionStore, LogNotifier, WebPushNotifier, type Notifier, type WebPushSubscription } from "./notifications/notifier.js";
import { InMemorySocialStore, RedisSocialStore, type SocialStore } from "./social/store.js";
import { InMemoryClubStore, RedisClubStore, type ClubStore } from "./clubs/store.js";
import { TournamentService, type TournamentMeta } from "./tournament/service.js";
import { matchEscrowAbi, tournamentEscrowAbi } from "../../protocol/src/abis.js";
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

// 30s timeout (default 10s): the public Celo Sepolia RPC (forno) is often slow
// from Fly, which was timing out the tournament lobby sync's nextTournamentId read.
const publicClient = createPublicClient({
  chain: chainFor(CHAIN_ID),
  transport: http(RPC_URL, { timeout: 30_000, retryCount: 2 }),
});
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
// Durable async store when REDIS_URL is set (survives restarts, shared across
// machines); in-memory otherwise. The client connects in the background and an
// `error` handler keeps a transient Redis hiccup from crashing the server (an
// unhandled ioredis 'error' event would otherwise exit the process). `family: 6`
// is required for Fly's internal IPv6 network.
let matchStore: MatchStore = new InMemoryMatchStore();
let socialStore: SocialStore = new InMemorySocialStore();
let clubStore: ClubStore = new InMemoryClubStore();
if (process.env.REDIS_URL) {
  const redis = new IORedis(process.env.REDIS_URL, { family: 6, maxRetriesPerRequest: 5, lazyConnect: true });
  redis.on("error", (e) => console.warn(`[redis] ${e.message}`));
  redis.on("ready", () => console.log("[redis] connected"));
  redis.connect().catch((e) => console.warn(`[redis] initial connect failed: ${(e as Error).message}`));
  matchStore = new RedisMatchStore(redis);
  socialStore = new RedisSocialStore(redis);
  clubStore = new RedisClubStore(redis);
  console.log("async store: redis · social store: redis · clubs: redis");
} else {
  console.log("async store: in-memory (set REDIS_URL for durability + scaling)");
}
const asyncMatches = new AsyncMatchService(matchStore, notifier);

// Tournaments: in-memory lobby + bracket orchestration (same single-machine
// model as matchmaking). When a bracket completes, the finalize hook reports the
// ordered standings to TournamentEscrow — but only if a funded operator signer and
// the contract address are configured; otherwise it logs (dev/scaffold).
const TOURNAMENT = (process.env.TOURNAMENT_ADDRESS || undefined) as Address | undefined;
const tournamentFinalize =
  SIGNER && SIGNER.startsWith("0x") && SIGNER.length === 66 && TOURNAMENT
    ? async (id: string, winners: Address[]) => {
        const wallet = createWalletClient({
          chain: chainFor(CHAIN_ID),
          transport: http(RPC_URL, { timeout: 60_000, retryCount: 2 }),
          account: privateKeyToAccount(SIGNER as Hex),
        });
        const hash = await wallet.writeContract({
          address: TOURNAMENT,
          abi: tournamentEscrowAbi,
          functionName: "finalize",
          args: [BigInt(id), winners],
          ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY } : {}),
        } as Parameters<typeof wallet.writeContract>[0]);
        console.log(`[tournament] finalized ${id} → ${winners.join(", ")} (${hash})`);
      }
    : async (id: string, winners: Address[]) => {
        console.log(`[tournament] (no signer) would finalize ${id} → ${winners.join(", ")}`);
      };
const tournaments = new TournamentService(tournamentFinalize);
console.log(TOURNAMENT ? `tournaments: on-chain @ ${TOURNAMENT}` : "tournaments: off-chain (set TOURNAMENT_ADDRESS)");

const CLUB_PAYOUT = [6500, 3500];
const CLUB_CUT_BPS = 800;
const CLUB_JOIN_WINDOW = 86400n; // 1 day
const CLUB_REFUND_WINDOW = 172800n; // 2 days

/** Operator-creates a private club tournament on-chain, tags it, and registers it. */
async function createClubTournament(clubId: string, token: Address, entryFee: bigint, maxPlayers: number): Promise<string> {
  if (!(SIGNER && SIGNER.startsWith("0x") && SIGNER.length === 66 && TOURNAMENT)) {
    throw new Error("tournaments not configured (need SERVER_SIGNER_KEY + TOURNAMENT_ADDRESS)");
  }
  const wallet = createWalletClient({
    chain: chainFor(CHAIN_ID),
    transport: http(RPC_URL, { timeout: 60_000, retryCount: 2 }),
    account: privateKeyToAccount(SIGNER as Hex),
  });
  const hash = await wallet.writeContract({
    address: TOURNAMENT,
    abi: tournamentEscrowAbi,
    functionName: "createTournament",
    args: [token, entryFee, maxPlayers, CLUB_CUT_BPS, CLUB_JOIN_WINDOW, CLUB_REFUND_WINDOW, CLUB_PAYOUT],
    ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY } : {}),
  } as Parameters<typeof wallet.writeContract>[0]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  // the created id is the first indexed topic of TournamentCreated (emitted by TOURNAMENT)
  const log = receipt.logs.find((l) => l.address.toLowerCase() === TOURNAMENT.toLowerCase());
  if (!log?.topics[1]) throw new Error("could not read created tournament id");
  const id = BigInt(log.topics[1]).toString();
  await clubStore.tagTournament(clubId, id);
  tournaments.register({
    id,
    token,
    entryFee: entryFee.toString(),
    maxPlayers,
    cutBps: CLUB_CUT_BPS,
    payoutBps: CLUB_PAYOUT,
    joinDeadline: Date.now() + Number(CLUB_JOIN_WINDOW) * 1000,
    clubId,
  });
  console.log(`[club] tournament ${id} created for club ${clubId} (${hash})`);
  return id;
}

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
  if (req.method === "POST" && url.pathname === "/async/create") {
    readJson(req)
      .then((b) => {
        const { address, session } = b as { address: Address; session: Address };
        if (!address || !session) throw new Error("address + session required");
        const matchId = (1n << 200n) + BigInt(Math.floor(Math.random() * 1e15)) * 1000n + BigInt(Math.floor(Math.random() * 1000));
        return asyncMatches.createOpen({
          matchId,
          chainId: BigInt(CHAIN_ID),
          verifier: VERIFIER,
          creator: address,
          session0: session,
          startTurn: Math.random() < 0.5 ? 0 : 1,
          mode: "casual",
        });
      })
      .then((matchId) => json(200, { matchId }))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/async/join") {
    readJson(req)
      .then((b) => {
        const { matchId, address, session } = b as { matchId: string; address: Address; session: Address };
        if (!matchId || !address || !session) throw new Error("matchId + address + session required");
        return asyncMatches.join(matchId, address, session);
      })
      .then((state) => json(200, state))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }
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
  // --- social: friends + challenge inbox (durable, wallet-identity) ---
  if (req.method === "POST" && url.pathname === "/social/befriend") {
    readJson(req)
      .then((b) => {
        const { a, b: friend } = b as { a: Address; b: Address };
        if (!a || !friend) throw new Error("a + b required");
        return socialStore.befriend(a, friend);
      })
      .then(() => json(200, { ok: true }))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/social/friends") {
    const address = url.searchParams.get("address") as Address | null;
    if (!address) return json(400, { error: "address required" });
    socialStore.friends(address).then((f) => json(200, { friends: f })).catch((e) => json(500, { error: (e as Error).message }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/social/challenge") {
    readJson(req)
      .then(async (b) => {
        const { from, to, matchId } = b as { from: Address; to: Address; matchId: string };
        if (!from || !to || !matchId) throw new Error("from + to + matchId required");
        await socialStore.addChallenge(to, { id: `${matchId}-${Date.now()}`, from, matchId, createdAt: Date.now() });
        await notifier.notifyChallenge(to, from, matchId).catch(() => {});
      })
      .then(() => json(200, { ok: true }))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/social/challenges") {
    const address = url.searchParams.get("address") as Address | null;
    if (!address) return json(400, { error: "address required" });
    socialStore.challenges(address).then((c) => json(200, { challenges: c })).catch((e) => json(500, { error: (e as Error).message }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/social/challenge/dismiss") {
    readJson(req)
      .then((b) => {
        const { address, id } = b as { address: Address; id: string };
        if (!address || !id) throw new Error("address + id required");
        return socialStore.removeChallenge(address, id);
      })
      .then(() => json(200, { ok: true }))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }
  // --- clubs: named groups with a shareable join code ---
  if (req.method === "POST" && url.pathname === "/clubs/create") {
    readJson(req)
      .then((b) => {
        const { name, owner } = b as { name: string; owner: Address };
        if (!name || !owner) throw new Error("name + owner required");
        return clubStore.create(name, owner);
      })
      .then((club) => json(200, club))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/clubs/join") {
    readJson(req)
      .then((b) => {
        const { code, member } = b as { code: string; member: Address };
        if (!code || !member) throw new Error("code + member required");
        return clubStore.joinByCode(code, member);
      })
      .then((club) => json(200, club))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/clubs/mine") {
    const address = url.searchParams.get("address") as Address | null;
    if (!address) return json(400, { error: "address required" });
    clubStore.listForMember(address).then((clubs) => json(200, { clubs })).catch((e) => json(500, { error: (e as Error).message }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/clubs/get") {
    const id = url.searchParams.get("id");
    if (!id) return json(400, { error: "id required" });
    clubStore.get(id).then((c) => (c ? json(200, c) : json(404, { error: "not found" }))).catch((e) => json(500, { error: (e as Error).message }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/clubs/tournament") {
    // a club member starts a club game; the operator creates it on-chain (tagged
    // private to the club) and registers it in the lobby.
    readJson(req)
      .then(async (b) => {
        const { clubId, token, entryFee, maxPlayers } = b as {
          clubId: string;
          token: Address;
          entryFee: string;
          maxPlayers?: number;
        };
        if (!clubId || !token || !entryFee) throw new Error("clubId + token + entryFee required");
        const club = await clubStore.get(clubId);
        if (!club) throw new Error("unknown club");
        const id = await createClubTournament(clubId, token, BigInt(entryFee), maxPlayers ?? 8);
        return { id };
      })
      .then((r) => json(200, r))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/clubs/tournaments") {
    const clubId = url.searchParams.get("clubId");
    if (!clubId) return json(400, { error: "clubId required" });
    json(200, { tournaments: tournaments.clubLobbies(clubId) });
    return;
  }
  // --- tournaments: Sit-and-Go lobby + bracket ---
  if (req.method === "POST" && url.pathname === "/tournaments/register") {
    // operator registers a tournament it just created on-chain
    readJson(req)
      .then((b) => {
        const meta = b as TournamentMeta;
        if (!meta?.id || !meta.token || !meta.maxPlayers) throw new Error("id + token + maxPlayers required");
        tournaments.register(meta);
      })
      .then(() => json(200, { ok: true }))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/tournaments") {
    const open = url.searchParams.get("open") === "1";
    // kick a debounced on-chain refresh in the background (never block the
    // response — a cold-start RPC can hang), and answer immediately with what we
    // have; the next poll sees the freshly-synced lobby.
    void maybeSyncTournaments();
    json(200, { tournaments: open ? tournaments.openLobbies() : tournaments.list() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/tournaments/state") {
    const id = url.searchParams.get("id");
    if (!id) return json(400, { error: "id required" });
    try {
      json(200, tournaments.state(id));
    } catch (e) {
      json(404, { error: (e as Error).message });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/tournaments/join") {
    // mirror an on-chain join so the server can seat the bracket
    readJson(req)
      .then((b) => {
        const { id, address } = b as { id: string; address: Address };
        if (!id || !address) throw new Error("id + address required");
        tournaments.join(id, address);
      })
      .then(() => json(200, { ok: true }))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/tournaments/my-game") {
    // a player's current bracket obligation (which game to play, and as host/guest)
    const id = url.searchParams.get("id");
    const address = url.searchParams.get("address") as Address | null;
    if (!id || !address) return json(400, { error: "id + address required" });
    try {
      json(200, { assignment: tournaments.assignment(id, address) });
    } catch (e) {
      json(404, { error: (e as Error).message });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/tournaments/game-created") {
    // the host reports the async match id it created so the guest can join
    readJson(req)
      .then((b) => {
        const { id, round, index, asyncMatchId } = b as {
          id: string;
          round: number;
          index: number;
          asyncMatchId: string;
        };
        if (!id || asyncMatchId == null) throw new Error("id + round + index + asyncMatchId required");
        tournaments.attachGame(id, round, index, asyncMatchId);
      })
      .then(() => json(200, { ok: true }))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/tournaments/result") {
    // a bracket game's winner (reported by the match coordinator)
    readJson(req)
      .then((b) => {
        const { id, round, index, winner } = b as { id: string; round: number; index: number; winner: Address };
        if (!id || winner == null) throw new Error("id + round + index + winner required");
        return tournaments.reportResult(id, round, index, winner);
      })
      .then(() => json(200, { ok: true }))
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

// Auto-register on-chain tournaments into the lobby: read every Open tournament
// from TournamentEscrow and register it (idempotent). Runs at startup (backfills
// the seed + anything created while we were down) and on an interval to pick up
// new ones, so no manual POST /tournaments/register is needed.
async function syncTournaments() {
  if (!TOURNAMENT) return;
  try {
    const next = (await publicClient.readContract({
      address: TOURNAMENT,
      abi: tournamentEscrowAbi,
      functionName: "nextTournamentId",
    })) as bigint;
    for (let i = 1n; i < next; i++) {
      const t = (await publicClient.readContract({
        address: TOURNAMENT,
        abi: tournamentEscrowAbi,
        functionName: "getTournament",
        args: [i],
      })) as {
        token: Address;
        entryFee: bigint;
        maxPlayers: number;
        cutBps: number;
        status: number;
        joinDeadline: bigint;
        payoutBps: readonly number[];
      };
      if (Number(t.status) !== 1) continue; // 1 = Open
      const tid = i.toString();
      const clubId = (await clubStore.clubOf(tid)) ?? undefined;
      tournaments.register({
        id: tid,
        token: t.token,
        entryFee: t.entryFee.toString(),
        maxPlayers: Number(t.maxPlayers),
        cutBps: Number(t.cutBps),
        payoutBps: (t.payoutBps as readonly (number | bigint)[]).map(Number),
        joinDeadline: Number(t.joinDeadline) * 1000,
        clubId,
      });
      if (clubId) tournaments.setClub(tid, clubId); // ensure it stays out of the public lobby
    }
  } catch (e) {
    console.warn(`[tournament] sync failed: ${(e as Error).message}`);
  }
}
let lastTournamentSync = 0;
/** Debounced sync — safe to call on every lobby request without hammering the RPC. */
async function maybeSyncTournaments() {
  if (!TOURNAMENT) return;
  const now = Date.now();
  if (now - lastTournamentSync < 15_000) return;
  lastTournamentSync = now;
  await syncTournaments();
}
if (TOURNAMENT) {
  // best-effort startup sync with a couple of retries (cold-start RPC can time out)
  void (async () => {
    for (let i = 0; i < 3; i++) {
      await syncTournaments();
      if (tournaments.list().length > 0) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();
  const ts = setInterval(() => void syncTournaments(), 60_000);
  if ("unref" in ts) ts.unref();
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
