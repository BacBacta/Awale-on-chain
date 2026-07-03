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
import {
  InMemorySubscriptionStore,
  RedisSubscriptionStore,
  LogNotifier,
  WebPushNotifier,
  type Notifier,
  type SubscriptionStore,
  type WebPushSubscription,
} from "./notifications/notifier.js";
import { InMemorySocialStore, RedisSocialStore, type SocialStore } from "./social/store.js";
import {
  InMemoryProfileStore,
  RedisProfileStore,
  freshProfile,
  liveStreak,
  applyDailySolve,
  migrateLocalStreak,
  applyGameResult,
  topByElo,
  type ProfileStore,
} from "./profile/store.js";
import { recordQuestGame, recordQuestDaily, questStates, currentProgress } from "./profile/quests.js";
import { retentionSweep } from "./retention.js";
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
// Async play's own move-clock: correspondence games are explicitly "play
// whenever", so the window is days, not the minutes a live match gets.
const ASYNC_TURN_CLOCK_MS = Number(process.env.ASYNC_TURN_CLOCK_MS ?? String(3 * 24 * 60 * 60 * 1000));
// A tournament is a live event — a host who never creates their bracket game
// gets a much shorter leash than an ordinary correspondence match.
const TOURNAMENT_WALKOVER_MS = Number(process.env.TOURNAMENT_WALKOVER_MS ?? String(15 * 60_000));
// Tournament bracket games: short per-move inactivity claim so a tournament
// stays a same-hour event (~45-90 min for 8 players) instead of drifting for
// days on the correspondence default.
const TOURNAMENT_TURN_CLOCK_MS = Number(process.env.TOURNAMENT_TURN_CLOCK_MS ?? String(10 * 60_000));
// Blitz: total thinking time per player for live matches (casual + staked).
// A full Awalé game can run 10-20 minutes; this audience plays in seconds-long
// rounds — 3 min/player bounds every live game to ~6 minutes.
const BLITZ_CLOCK_MS = Number(process.env.BLITZ_CLOCK_MS ?? String(3 * 60_000));

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

// Durable stores when REDIS_URL is set (survive restarts/deploys, shared across
// machines); in-memory otherwise. The client connects in the background and an
// `error` handler keeps a transient Redis hiccup from crashing the server (an
// unhandled ioredis 'error' event would otherwise exit the process). `family: 6`
// is required for Fly's internal IPv6 network.
let matchStore: MatchStore = new InMemoryMatchStore();
let socialStore: SocialStore = new InMemorySocialStore();
let subStore: SubscriptionStore = new InMemorySubscriptionStore();
let profiles: ProfileStore = new InMemoryProfileStore();
if (process.env.REDIS_URL) {
  const redis = new IORedis(process.env.REDIS_URL, { family: 6, maxRetriesPerRequest: 5, lazyConnect: true });
  redis.on("error", (e) => console.warn(`[redis] ${e.message}`));
  redis.on("ready", () => console.log("[redis] connected"));
  redis.connect().catch((e) => console.warn(`[redis] initial connect failed: ${(e as Error).message}`));
  matchStore = new RedisMatchStore(redis);
  socialStore = new RedisSocialStore(redis);
  subStore = new RedisSubscriptionStore(redis);
  profiles = new RedisProfileStore(redis);
  console.log("stores: redis (async, social, push subscriptions, profiles)");
} else {
  console.log("stores: in-memory (set REDIS_URL for durability + scaling)");
}

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const notifier: Notifier =
  VAPID_PUBLIC && VAPID_PRIVATE
    ? new WebPushNotifier(subStore, { publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE, subject: process.env.VAPID_SUBJECT ?? "mailto:ops@awale.app" })
    : new LogNotifier();
console.log(`push: ${VAPID_PUBLIC && VAPID_PRIVATE ? "web-push enabled" : "log-only (set VAPID keys)"}`);
// Every finished two-player game (casual quick-match or async, by play or by
// forfeit) lands here: Elo transfer + played/won counters on both profiles.
// Fire-and-forget — a profile hiccup must never affect the game itself.
function recordGameResult(players: [Address, Address], winner: number): void {
  void (async () => {
    const [p0, p1] = await Promise.all([
      profiles.get(players[0]).then((p) => p ?? freshProfile(players[0])),
      profiles.get(players[1]).then((p) => p ?? freshProfile(players[1])),
    ]);
    const [n0, n1] = applyGameResult(p0, p1, winner);
    await profiles.save(recordQuestGame(n0, winner === 0));
    await profiles.save(recordQuestGame(n1, winner === 1));
  })().catch((e) => console.warn(`[profile] result not recorded: ${(e as Error).message}`));
}

const asyncMatches = new AsyncMatchService(matchStore, notifier, { onResult: recordGameResult });

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
          transport: http(RPC_URL),
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

// Auto-rotation: the moment a bracket goes live, open an identical table so
// the lobby is never empty — unless one is already waiting. Join/refund
// windows are durations (seconds from creation), mirroring createTournament.
const TOURNAMENT_JOIN_WINDOW_S = Number(process.env.TOURNAMENT_JOIN_WINDOW_S ?? String(7 * 24 * 3600));
const TOURNAMENT_REFUND_WINDOW_S = Number(process.env.TOURNAMENT_REFUND_WINDOW_S ?? String(30 * 24 * 3600));
function rotateTournament(meta: TournamentMeta): void {
  if (!(SIGNER && SIGNER.startsWith("0x") && SIGNER.length === 66 && TOURNAMENT)) return;
  void (async () => {
    if (tournaments.openLobbies().length > 0) return; // a table is already waiting
    const wallet = createWalletClient({
      chain: chainFor(CHAIN_ID),
      transport: http(RPC_URL),
      account: privateKeyToAccount(SIGNER as Hex),
    });
    const hash = await wallet.writeContract({
      address: TOURNAMENT,
      abi: tournamentEscrowAbi,
      functionName: "createTournament",
      args: [
        meta.token,
        BigInt(meta.entryFee),
        meta.maxPlayers,
        meta.cutBps,
        BigInt(TOURNAMENT_JOIN_WINDOW_S),
        BigInt(TOURNAMENT_REFUND_WINDOW_S),
        meta.payoutBps,
      ],
      ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY } : {}),
    } as Parameters<typeof wallet.writeContract>[0]);
    console.log(`[tournament] rotation: new table cloned from #${meta.id} (${hash})`);
    await publicClient.waitForTransactionReceipt({ hash });
    lastTournamentSync = 0; // let the next lobby request pick it up immediately
    await syncTournaments();
  })().catch((e) => console.warn(`[tournament] rotation failed: ${(e as Error).message}`));
}

const tournaments = new TournamentService(tournamentFinalize, { onStart: rotateTournament });
console.log(TOURNAMENT ? `tournaments: on-chain @ ${TOURNAMENT}` : "tournaments: off-chain (set TOURNAMENT_ADDRESS)");

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
  if (req.method === "POST" && url.pathname === "/async/claim-timeout") {
    readJson(req)
      .then((b) => {
        const { matchId, claimant } = b as { matchId: string; claimant: 0 | 1 };
        if (!matchId || claimant == null) throw new Error("matchId + claimant required");
        return asyncMatches.claimTimeout(matchId, claimant, ASYNC_TURN_CLOCK_MS);
      })
      .then((state) => json(200, { state }))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }
  // --- player profile: the durable cross-device identity (streak, stats) ---
  if (req.method === "GET" && url.pathname === "/profile") {
    const address = url.searchParams.get("address") as Address | null;
    if (!address) return json(400, { error: "address required" });
    (async () => {
      const p = (await profiles.get(address)) ?? freshProfile(address);
      await profiles.save({ ...p, lastSeenAt: Date.now() });
      json(200, {
        profile: {
          ...p,
          streak: liveStreak(p),
          quests: questStates(currentProgress(p)), // resolved for today, not the raw counters
        },
      });
    })().catch((e) => json(500, { error: (e as Error).message }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/leaderboard") {
    const n = Math.min(50, Math.max(1, Number(url.searchParams.get("n") ?? "20")));
    (async () => {
      const addrs = await profiles.list();
      const all = (await Promise.all(addrs.map((a) => profiles.get(a)))).filter((p) => p !== null);
      json(200, {
        leaders: topByElo(all, n).map((p) => ({
          address: p.address,
          elo: p.elo,
          gamesPlayed: p.gamesPlayed,
          gamesWon: p.gamesWon,
        })),
      });
    })().catch((e) => json(500, { error: (e as Error).message }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/profile/daily-solved") {
    readJson(req)
      .then(async (b) => {
        const { address, local } = b as { address: Address; local?: { count: number; lastDone: string } };
        if (!address) throw new Error("address required");
        let p = (await profiles.get(address)) ?? freshProfile(address);
        if (local) p = migrateLocalStreak(p, local); // one-time device-streak adoption
        p = applyDailySolve({ ...p, lastSeenAt: Date.now() });
        p = recordQuestDaily(p);
        await profiles.save(p);
        return { streak: liveStreak(p) };
      })
      .then((out) => json(200, out))
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
      .then((b) => {
        const { from, to, matchId } = b as { from: Address; to: Address; matchId: string };
        if (!from || !to || !matchId) throw new Error("from + to + matchId required");
        return socialStore.addChallenge(to, { id: `${matchId}-${Date.now()}`, from, matchId, createdAt: Date.now() });
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
        // bracket games run on minutes: swap the correspondence claim window
        // for the tournament one, starting now
        return asyncMatches.setTurnClock(asyncMatchId, TOURNAMENT_TURN_CLOCK_MS);
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
  if (req.method === "POST" && url.pathname === "/tournaments/claim-walkover") {
    // the guest advances by walkover: the host never created the bracket game
    readJson(req)
      .then((b) => {
        const { id, round, index, claimant } = b as { id: string; round: number; index: number; claimant: Address };
        if (!id || !claimant) throw new Error("id + round + index + claimant required");
        return tournaments.claimWalkover(id, round, index, claimant, TOURNAMENT_WALKOVER_MS);
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
  blitzClockMs: BLITZ_CLOCK_MS,
  onGameOver: (matchId, winner) => {
    console.log(`[match ${matchId}] over, winner=${winner} — awaiting result signatures`);
  },
  onResult: recordGameResult,
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
      tournaments.register({
        id: i.toString(),
        token: t.token,
        entryFee: t.entryFee.toString(),
        maxPlayers: Number(t.maxPlayers),
        cutBps: Number(t.cutBps),
        payoutBps: (t.payoutBps as readonly (number | bigint)[]).map(Number),
        joinDeadline: Number(t.joinDeadline) * 1000,
      });
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
  { escrow: ESCROW, ctx: { chainId: BigInt(CHAIN_ID), verifier: VERIFIER, clockMs: BLITZ_CLOCK_MS }, readMatch },
  hub,
);

// Retention sweep: streak-expiry and stale-turn nudges, at most one of each
// per player per UTC day (deduped inside the sweep via the profile record).
const RETENTION_INTERVAL_MS = Number(process.env.RETENTION_INTERVAL_MS ?? "900000"); // 15 min
{
  const rt = setInterval(
    () =>
      void retentionSweep({
        profiles,
        listMatchesFor: (a) => asyncMatches.listForPlayer(a),
        notify: (a, n) => notifier.notify(a, n),
      }).catch((e) => console.warn(`[retention] sweep error: ${(e as Error).message}`)),
    RETENTION_INTERVAL_MS,
  );
  if ("unref" in rt) rt.unref();
}

httpServer.listen(PORT, () => {
  console.log(`Awalé game server on :${PORT} — chain ${CHAIN_ID}, escrow ${ESCROW}`);
  console.log(`settlement signer: ${settlement ? "configured" : "not set (read-only)"}`);
  console.log(`Self personhood gate: ${selfVerifier ? "enabled" : "disabled (ranked/cash ungated)"}`);
});
