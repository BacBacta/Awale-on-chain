// Runnable game server: ties the tested pieces (GameHub, on-chain listener,
// Socket.IO transport, settlement client) to a live deployment.
//
// Env (see .env.example): RPC_URL, CHAIN_ID, ESCROW_ADDRESS, VERIFIER_ADDRESS,
// PORT, SERVER_SIGNER_KEY (optional), FEE_CURRENCY (optional), SELF_SCOPE,
// SELF_ENDPOINT, SELF_MOCK_PASSPORT (optional).

import { createServer } from "node:http";
import { Server } from "socket.io";
import { createPublicClient, createWalletClient, http, parseAbiItem, type Address, type Hex } from "viem";
import { celo, celoSepolia, celoAlfajores } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createNonceManager, jsonRpc } from "viem/nonce";
import { GameHub } from "./hub.js";
import { attachSocketIO } from "./server.js";
import { watchMatchJoined, watchStartFinalized, openMatchFromChain, type ChainMatch, type EventWatcher } from "./listener.js";
import { SettlementClient } from "./chain.js";
import { SettlementCoordinator } from "./settlement-coordinator.js";
import { keeperActions, runKeeper, EscrowStatus, type KeeperMatch } from "./keeper.js";
import { AsyncMatchService } from "./async-match.js";
import { InMemoryMatchStore, type MatchStore } from "./persistence/store.js";
import { RedisMatchStore } from "./persistence/redis-store.js";
import { InMemoryCashPairStore, RedisCashPairStore, type CashPairStore } from "./cash-pair-store.js";
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
import { recordQuestGame, recordQuestDaily, recordQuestPractice, questStates, currentProgress, isBeginner } from "./profile/quests.js";
import { retentionSweep } from "./retention.js";
import { TournamentService, type TournamentMeta } from "./tournament/service.js";
import {
  WeeklyLeague,
  InMemoryLeagueStore,
  RedisLeagueStore,
  type LeagueStore,
  type LeagueWinner,
} from "./weekly-league.js";
import { SettledLedger, InMemoryLedgerStore, RedisLedgerStore, type LedgerStore } from "./settled-ledger.js";
import { InboxNotifier, InMemoryInboxStore, RedisInboxStore, inboxSnapshot, type InboxStore } from "./notifications/inbox.js";
import { erc20Abi, matchEscrowAbi, tournamentEscrowAbi } from "../../protocol/src/abis.js";
import { SelfPersonhoodVerifier } from "./personhood/self-verifier.js";
import { InMemoryPersonhoodRegistry, RedisPersonhoodRegistry } from "./personhood/registry.js";
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
// Total per-player clock, DISABLED by default (0): live play uses a
// 10s-per-move rhythm with client auto-play instead of a total blitz clock —
// no total-time flag-fall, no frozen settlement. Set BLITZ_CLOCK_MS>0 to
// re-enable a total clock. TURN_CLOCK_MS is the server's per-move backstop
// (default 30s; the client auto-plays well before it at 10s).
const BLITZ_CLOCK_MS = Number(process.env.BLITZ_CLOCK_MS ?? "0") || undefined;
const TURN_CLOCK_MS = Number(process.env.TURN_CLOCK_MS ?? "30000");

// Match ids the server has seen join, polled by the keeper for time-based
// actions (finalize proposed results, void expired matches). Terminal matches
// are pruned.
const tracked = new Set<string>();
// wallet pairs per tracked match (filled by the keeper's reads) — needed to
// notify refunds when a match is voided
const keeperPlayers = new Map<string, [Address, Address]>();

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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Read an on-chain match into the hub's ChainMatch shape.
 *
 *  The RPC is load-balanced and its nodes lag each other: right after
 *  StartFinalized, a stale node can still serve the PRE-JOIN state — with
 *  session1 = 0x0. Opening the hub with a zero session bricks the match:
 *  every one of player 1's signatures fails "bad signature" forever (caught
 *  red-handed by the two-player e2e). Retry until the joined state is
 *  actually visible. */
async function readMatch(matchId: bigint): Promise<ChainMatch> {
  for (let i = 0; ; i++) {
    const m = (await publicClient.readContract({
      address: ESCROW,
      abi: matchEscrowAbi,
      functionName: "getMatch",
      args: [matchId],
    })) as { session0: Address; session1: Address; startTurn: number };
    if (m.session1 !== ZERO_ADDRESS && m.session0 !== ZERO_ADDRESS) {
      return { matchId, session0: m.session0, session1: m.session1, startTurn: Number(m.startTurn) };
    }
    if (i >= 14) throw new Error(`match ${matchId}: sessions still incomplete after retries`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// optional: a funded signer lets the server submit settlements.
// ONE shared account with a serialized nonce manager: the operator transacts
// from several concurrent paths (keeper, finalizeStart, settleSigned, league
// payouts) and per-call accounts were guessing nonces against lagging RPC
// nodes — settlements died on "nonce too low" (caught by the two-player e2e).
const operatorAccount =
  SIGNER && SIGNER.startsWith("0x") && SIGNER.length === 66
    ? privateKeyToAccount(SIGNER as Hex, { nonceManager: createNonceManager({ source: jsonRpc() }) })
    : undefined;
let settlement: SettlementClient | undefined;
if (operatorAccount) {
  settlement = new SettlementClient({
    rpcUrl: RPC_URL,
    escrow: ESCROW,
    account: operatorAccount,
    feeCurrency: FEE_CURRENCY,
    chainId: CHAIN_ID, // was hardcoded to mainnet inside the client — every
    // server write on Sepolia bounced with "invalid chain ID"
  });
}

// optional: Self proof-of-personhood gating for ranked/cash play
const SELF_SCOPE = process.env.SELF_SCOPE;
const SELF_ENDPOINT = process.env.SELF_ENDPOINT;
let personhood: PersonhoodRegistry = new InMemoryPersonhoodRegistry(); // Redis-backed below when REDIS_URL is set
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
let leagueStore: LeagueStore = new InMemoryLeagueStore();
let ledgerStore: LedgerStore = new InMemoryLedgerStore();
let inboxStore: InboxStore = new InMemoryInboxStore();
// tiny KV facade for small markers/counters (funnel events, referrals):
// redis when configured, in-process map otherwise
let kv: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<unknown> } = (() => {
  const mem = new Map<string, string>();
  return {
    async get(k: string) {
      return mem.get(k) ?? null;
    },
    async set(k: string, v: string) {
      mem.set(k, v);
    },
  };
})();
// Half-built cash pairs survive a restart so a mid-flight stake is never
// stranded (P1-4): Redis-backed when configured, in-memory otherwise.
let cashPairStore: CashPairStore = new InMemoryCashPairStore();
if (process.env.REDIS_URL) {
  const redis = new IORedis(process.env.REDIS_URL, { family: 6, maxRetriesPerRequest: 5, lazyConnect: true });
  redis.on("error", (e) => console.warn(`[redis] ${e.message}`));
  redis.on("ready", () => console.log("[redis] connected"));
  redis.connect().catch((e) => console.warn(`[redis] initial connect failed: ${(e as Error).message}`));
  matchStore = new RedisMatchStore(redis);
  socialStore = new RedisSocialStore(redis);
  subStore = new RedisSubscriptionStore(redis);
  profiles = new RedisProfileStore(redis);
  leagueStore = new RedisLeagueStore(redis);
  ledgerStore = new RedisLedgerStore(redis);
  inboxStore = new RedisInboxStore(redis);
  personhood = new RedisPersonhoodRegistry(redis);
  cashPairStore = new RedisCashPairStore(redis);
  kv = redis;
  console.log("stores: redis (async, social, push subscriptions, profiles, league, ledger, inbox, personhood, cash-pairs)");
} else {
  console.log("stores: in-memory (set REDIS_URL for durability + scaling)");
}
const ledger = new SettledLedger(ledgerStore);

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
// Every notification is recorded in the in-app inbox first (the guaranteed
// channel — MiniPay's webview may not support Web Push at all), then sent on
// the push channel when configured.
const pushNotifier: Notifier =
  VAPID_PUBLIC && VAPID_PRIVATE
    ? new WebPushNotifier(subStore, { publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE, subject: process.env.VAPID_SUBJECT ?? "mailto:ops@awale.app" })
    : new LogNotifier();
const notifier: Notifier = new InboxNotifier(inboxStore, pushNotifier);
console.log(`push: ${VAPID_PUBLIC && VAPID_PRIVATE ? "web-push enabled" : "log-only (set VAPID keys)"} + in-app inbox`);
// Every finished two-player game (casual quick-match or async, by play or by
// forfeit) lands here: Elo transfer + played/won counters on both profiles.
// Fire-and-forget — a profile hiccup must never affect the game itself.
function recordGameResult(players: [Address, Address], winner: number, pool: "live" | "async" = "live"): void {
  void (async () => {
    const [p0, p1] = await Promise.all([
      profiles.get(players[0]).then((p) => p ?? freshProfile(players[0])),
      profiles.get(players[1]).then((p) => p ?? freshProfile(players[1])),
    ]);
    const [n0, n1] = applyGameResult(p0, p1, winner, pool);
    await profiles.save(recordQuestGame(n0, winner === 0));
    await profiles.save(recordQuestGame(n1, winner === 1));
  })().catch((e) => console.warn(`[profile] result not recorded: ${(e as Error).message}`));
}

// correspondence games rate the eloAsync pool; live/cash use eloLive
const asyncMatches = new AsyncMatchService(matchStore, notifier, {
  onResult: (players, winner) => recordGameResult(players, winner, "async"),
});

// Weekly prize-pool league — the recurring money event. Credited from the
// chain's MatchSettled events (see the watcher near the bottom), paid out and
// reset every Monday 00:00 UTC by leagueTick.
const league = new WeeklyLeague(leagueStore, {
  minGames: Number(process.env.LEAGUE_MIN_GAMES ?? "5"),
  pairCap: Number(process.env.LEAGUE_PAIR_CAP ?? "3"),
  poolShareBps: Number(process.env.LEAGUE_POOL_SHARE_BPS ?? "5000"),
  // until verified-payout is live, an unclaimed pot must not compound into a
  // sybil-worthy prize — default cap: 25 tokens (18 decimals)
  maxCarryWei: BigInt(process.env.LEAGUE_MAX_CARRY_WEI ?? "25000000000000000000"),
  refBonusCap: Number(process.env.LEAGUE_REF_BONUS_CAP ?? "5"),
});
/** League points a referrer earns when their friend settles a first cash game. */
const REFERRAL_POINTS = Number(process.env.REFERRAL_POINTS ?? "2");

// --- funnel events: anonymous per-day counters (name whitelist, no payloads).
// Racy read-modify-write is fine here — these steer product decisions, not money.
const FUNNEL_EVENTS = new Set([
  "app_open",
  "tutorial_done",
  "practice_start",
  "quick_match_start",
  "money_open",
  "match_created",
  "match_joined",
  "daily_solved",
]);
const evKey = (day: string, name: string) => `awale:ev:${day}:${name}`;
async function bumpEvent(name: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const cur = Number((await kv.get(evKey(day, name))) ?? 0);
  await kv.set(evKey(day, name), String(cur + 1));
}
async function readEvent(day: string, name: string): Promise<number> {
  return Number((await kv.get(evKey(day, name))) ?? 0);
}

// --- referral: a friend arrives via ?ref=<address>. The pending marker only
// converts when the referee settles a FIRST cash game — they've paid real
// rake by then, so manufacturing "friends" costs a farmer more than the
// capped league points are worth.
const refPendingKey = (a: string) => `awale:ref:pending:${a.toLowerCase()}`;
const refDoneKey = (a: string) => `awale:ref:done:${a.toLowerCase()}`;
async function registerReferral(referee: Address, referrer: Address): Promise<void> {
  if (await kv.get(refDoneKey(referee))) return; // already converted
  if (await kv.get(refPendingKey(referee))) return; // first referrer wins
  await kv.set(refPendingKey(referee), referrer.toLowerCase());
}
async function convertReferral(player: Address): Promise<void> {
  const referrer = await kv.get(refPendingKey(player));
  if (!referrer) return;
  await kv.set(refDoneKey(player), "1");
  await kv.set(refPendingKey(player), "");
  const awarded = await league.addReferralBonus(referrer as Address, REFERRAL_POINTS);
  if (!awarded) return; // weekly cap reached — conversion still consumed
  console.log(`[referral] ${player} converted → +${REFERRAL_POINTS} league pts for ${referrer}`);
  void notifier
    .notify(referrer as Address, {
      title: "Your friend is playing! 🎉",
      body: `They just finished their first money game — you earned +${REFERRAL_POINTS} league points.`,
      url: "/compete",
      tag: `awale-ref-${player.toLowerCase()}`,
    })
    .catch(() => {});
}

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
          account: operatorAccount!,
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

// Tournaments were replaced by the weekly league as the recurring money event
// (a bracket needs N players on the same clock; a leaderboard works at any
// concurrency). The service + endpoints stay so an already-started bracket can
// finish and settle, but nothing recruits: no UI entry, no auto-rotation.
const tournaments = new TournamentService(tournamentFinalize);
console.log(TOURNAMENT ? `tournaments: legacy settle-only @ ${TOURNAMENT}` : "tournaments: off (replaced by weekly league)");

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
      const progress = currentProgress(p);
      json(200, {
        profile: {
          ...p,
          streak: liveStreak(p),
          // resolved for today, not the raw counters; brand-new players get
          // the gentler beginner quest set
          quests: questStates(progress, isBeginner(p, progress)),
          // personhood status so the app can drop the "verify" prompt once done
          // (false whenever Self isn't configured — the gate is simply off)
          verified: selfVerifier ? await personhood.isVerified(address) : false,
        },
      });
    })().catch((e) => json(500, { error: (e as Error).message }));
    return;
  }
  // --- a practice-vs-AI game finished (feeds the beginner quest; vanity only) ---
  if (req.method === "POST" && url.pathname === "/profile/practice-played") {
    readJson(req)
      .then(async (b) => {
        const { address } = b as { address: Address };
        if (!address) throw new Error("address required");
        const p = (await profiles.get(address)) ?? freshProfile(address);
        await profiles.save(recordQuestPractice({ ...p, lastSeenAt: Date.now() }));
      })
      .then(() => json(200, { ok: true }))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }
  // --- funnel events: anonymous per-day counters so we can SEE where new
  //     players drop off instead of guessing (name whitelist, address hashed
  //     into a per-day unique set via the profile store's redis) ---
  if (req.method === "POST" && url.pathname === "/events") {
    readJson(req)
      .then((b) => {
        const { name } = b as { name: string };
        if (!name || !FUNNEL_EVENTS.has(name)) throw new Error("unknown event");
        return bumpEvent(name);
      })
      .then(() => json(200, { ok: true }))
      .catch((e) => json(400, { error: (e as Error).message }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/events") {
    const day = url.searchParams.get("day") ?? new Date().toISOString().slice(0, 10);
    (async () => {
      const out: Record<string, number> = {};
      for (const name of FUNNEL_EVENTS) out[name] = await readEvent(day, name);
      json(200, { day, events: out });
    })().catch((e) => json(500, { error: (e as Error).message }));
    return;
  }
  // --- referral: friend arrives via ?ref=<address>; the bonus only fires
  //     when the friend settles a FIRST cash game (rake paid = sybil cost) ---
  if (req.method === "POST" && url.pathname === "/referral/claim") {
    readJson(req)
      .then(async (b) => {
        const { referee, referrer } = b as { referee: Address; referrer: Address };
        if (!referee || !referrer) throw new Error("referee + referrer required");
        if (referee.toLowerCase() === referrer.toLowerCase()) throw new Error("cannot refer yourself");
        await registerReferral(referee, referrer);
      })
      .then(() => json(200, { ok: true }))
      .catch((e) => json(400, { error: (e as Error).message }));
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
  // --- weekly league: this week's race, my rank, last week's winners ---
  if (req.method === "GET" && url.pathname === "/weekly-league") {
    const address = url.searchParams.get("address") as Address | null;
    league
      .snapshot(address ?? undefined)
      .then((s) => json(200, s))
      .catch((e) => json(500, { error: (e as Error).message }));
    return;
  }
  // --- all-time money leaderboard, fed from MatchSettled (was a client-side
  //     scan of every log since block 0 on each visit) ---
  if (req.method === "GET" && url.pathname === "/money-leaderboard") {
    const n = Math.min(200, Math.max(1, Number(url.searchParams.get("n") ?? "25")));
    ledger
      .top(n)
      .then((leaders) => json(200, { leaders }))
      .catch((e) => json(500, { error: (e as Error).message }));
    return;
  }
  // --- in-app notification inbox: the push fallback ---
  if (req.method === "GET" && url.pathname === "/inbox") {
    const address = url.searchParams.get("address") as Address | null;
    if (!address) return json(400, { error: "address required" });
    inboxSnapshot(inboxStore, address)
      .then((s) => json(200, s))
      .catch((e) => json(500, { error: (e as Error).message }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/inbox/seen") {
    readJson(req)
      .then((b) => {
        const { address } = b as { address: Address };
        if (!address) throw new Error("address required");
        return inboxStore.setLastSeen(address, Date.now());
      })
      .then(() => json(200, { ok: true }))
      .catch((e) => json(400, { error: (e as Error).message }));
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
        // the Self mobile app POSTs the proof with no top-level address — the
        // identity is disclosed by the proof itself and derived server-side;
        // any `address` here is only a fallback (dev tools / the mock path)
        const { address, ...proof } = JSON.parse(body) as { address?: Address };
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

// Hub recovery — rebuild a staked match from its on-chain record when a
// client watches one the hub doesn't hold. This happens for real: the
// MatchJoined/StartFinalized event watchers are best-effort on forno (the
// same lesson the settled pipeline learned), and a restart drops every open
// match from memory. Without this, two players fully staked into an Active
// match stare at "Connected" forever. If the first-move flip is still
// pending, finalize it here (the contract re-rolls an aged-out reveal block;
// the client's re-watch a few seconds later completes the second step).
const START_UNSET = 255;
const hydrating = new Set<string>();
async function openFromChain(matchId: bigint): Promise<void> {
  const key = matchId.toString();
  if (hydrating.has(key)) return;
  hydrating.add(key);
  try {
    const read = async () =>
      (await publicClient.readContract({
        address: ESCROW,
        abi: matchEscrowAbi,
        functionName: "getMatch",
        args: [matchId],
      })) as { session0: Address; session1: Address; status: number; startTurn: number };
    // The RPC's stale windows last 30-90s, not seconds: one polite attempt
    // per watch never caught up (the keeper beat it by a minute). Be
    // patient INSIDE one hydration instead — poll, skip stale reads, and
    // push finalizeStart until the board can open.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (hub.get(matchId)) return; // opened meanwhile (event watcher / us)
      let m: Awaited<ReturnType<typeof read>>;
      try {
        m = await read();
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (Number(m.status) !== EscrowStatus.Active) return; // settled/refunded — nothing to open
      tracked.add(key); // keeper takes over the lifecycle (finalize retries, TTL void)
      if (m.session0 === ZERO_ADDRESS || m.session1 === ZERO_ADDRESS) {
        await new Promise((r) => setTimeout(r, 3000)); // stale node — try another
        continue;
      }
      if (Number(m.startTurn) === START_UNSET) {
        if (!settlement) return;
        try {
          const hash = await settlement.finalizeStart(matchId);
          await publicClient.waitForTransactionReceipt({ hash });
        } catch {
          /* too early, raced, already fixed, or receipt flake — loop re-reads */
        }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      openMatchFromChain(
        hub,
        { matchId, session0: m.session0, session1: m.session1, startTurn: Number(m.startTurn) },
        { chainId: BigInt(CHAIN_ID), verifier: VERIFIER, clockMs: BLITZ_CLOCK_MS },
      );
      console.log(`[hydrate] match ${key} rebuilt from chain (startTurn=${m.startTurn}, attempt ${attempt + 1})`);
      return;
    }
    console.warn(`[hydrate] match ${key}: gave up after 20 attempts (~60s) — next watch retries`);
  } finally {
    hydrating.delete(key);
  }
}

const socketHandle = attachSocketIO(io, {
  hub,
  coordinator,
  personhood: selfVerifier ? personhood : undefined,
  casualCtx: { chainId: BigInt(CHAIN_ID), verifier: VERIFIER },
  blitzClockMs: BLITZ_CLOCK_MS,
  turnClockMs: TURN_CLOCK_MS,
  onGameOver: (matchId, winner) => {
    console.log(`[match ${matchId}] over, winner=${winner} — awaiting result signatures`);
  },
  onResult: recordGameResult,
  // matchmaking rates from the server profile — the client's "elo" field is
  // attacker-chosen and only a fallback for players with no profile yet
  eloOf: async (address) => (await profiles.get(address))?.elo ?? null,
  // cash quick-match is Elo-aware now (P0-2): sharks-vs-fish on a raked pot is
  // the biggest churn risk, so beginners don't get fed to the best player.
  cashMatchmaking: {
    baseWindow: Number(process.env.CASH_BASE_WINDOW ?? "200"),
    windowGrowthPerSec: Number(process.env.CASH_WINDOW_GROWTH ?? "15"),
    pairAnyoneAfterSec: Number(process.env.CASH_PAIR_ANYONE_AFTER_SEC ?? "120"),
  },
  // stake-band boundaries (P0-3) are computed at this token's decimals
  stakeDecimals: Number(process.env.STAKE_DECIMALS ?? "18"),
  cashPairStore,
  openFromChain,
});

// Boot recovery (P1-4): abort any cash pair the previous process left
// half-built, so a mid-flight stake is freed (the creator is told to reclaim
// it next time they queue). Same spirit as the keeper re-arming on-chain
// timeouts on boot.
void socketHandle
  .recoverCashPairs()
  .then((n) => n > 0 && console.log(`[boot] recovered ${n} half-built cash pair(s) — players will be told to reclaim any mid-flight stake`))
  .catch((e) => console.warn(`[boot] cash-pair recovery failed: ${(e as Error).message}`));

// Periodic matchmaking sweep (P0-1): pairing was previously evaluated ONLY when
// a player enqueued, so two people already waiting never matched as their
// windows widened — a third arrival was needed. Sweep on an interval so a
// compatible pair unsticks on its own. Same runner pattern as the keeper.
const MATCHMAKE_SWEEP_MS = Number(process.env.MATCHMAKE_SWEEP_MS ?? "2000");
const st = setInterval(() => socketHandle.sweepQueues(), MATCHMAKE_SWEEP_MS);
if ("unref" in st) st.unref?.();

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
      })) as { status: number; startTurn: number; challengeDeadline: bigint; activeDeadline: bigint; revealBlock: bigint; player0: Address; player1: Address };
      const status = Number(m.status);
      if (status === EscrowStatus.Resolved || status === EscrowStatus.Voided || status === EscrowStatus.Cancelled) {
        tracked.delete(idStr); // terminal — stop watching
        continue;
      }
      keeperPlayers.set(idStr, [m.player0, m.player1]);
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
    for (const a of actions) {
      console.log(`[keeper] ${a.action} match ${a.matchId}`);
      if (a.action === "voidExpired") {
        // an expired match just refunded both stakes — a silent refund reads
        // as lost money to whoever forgot the match existed
        const players = keeperPlayers.get(a.matchId.toString());
        for (const p of players ?? []) {
          void notifier
            .notify(p, {
              title: "Match expired — stake refunded",
              body: `Match #${a.matchId} was never finished. Your full stake is back in your wallet.`,
              url: "/matches",
              tag: `awale-refund-${a.matchId}`,
            })
            .catch(() => {});
        }
      }
    }
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
// Tournaments are retired (replaced by the weekly league): no startup sync, no
// interval. The debounced on-demand sync in GET /tournaments still works for
// an in-flight bracket reached by deep link — otherwise the chain is never polled.
watchStartFinalized(
  publicClient as unknown as EventWatcher,
  { escrow: ESCROW, ctx: { chainId: BigInt(CHAIN_ID), verifier: VERIFIER, clockMs: BLITZ_CLOCK_MS }, readMatch },
  hub,
);

// Settled-match pipeline: MatchSettled is emitted by every staked settlement
// path (settleSigned, finalize after the challenge window, a successful
// challenge, draws included) — the only authoritative "money actually moved"
// signal. One event feeds three things, all gated by the durable ledger so
// watcher + backfill + restarts stay exactly-once:
//   1. the weekly league (points + pool),
//   2. the all-time money leaderboard,
//   3. the player profiles (Elo, played/won, quests) — a cash game must count
//      for progression at least as much as a casual one does.
async function onSettled(matchId: bigint, winner: number, prizeWei: bigint, at: Date): Promise<void> {
  const key = matchId.toString();
  if (!(await ledger.claim(key))) return;
  const m = (await publicClient.readContract({
    address: ESCROW,
    abi: matchEscrowAbi,
    functionName: "getMatch",
    args: [matchId],
  })) as { token: Address; stake: bigint; player0: Address; player1: Address; rakeBps: number };
  await league.recordGame([m.player0, m.player1], winner, BigInt(m.stake) * 2n, Number(m.rakeBps), m.token, at);
  const human = (wei: bigint) => (Number(wei) / 1e18).toFixed(2).replace(/\.00$/, ""); // test token: 18 decimals
  if (winner === 2) {
    // draw: both stakes came back in full — say so, or the refund is silent
    for (const p of [m.player0, m.player1]) {
      void notifier
        .notify(p, {
          title: "Draw — stake returned",
          body: `Match #${key} ended in a draw. Your full stake is back in your wallet.`,
          url: "/matches",
          tag: `awale-paid-${key}`,
        })
        .catch(() => {});
    }
  }
  if (winner === 0 || winner === 1) {
    await ledger.recordWin(winner === 0 ? m.player0 : m.player1, prizeWei);
    // THE notification: money arrived. The single best re-engagement hook a
    // money game has — it was silent until now.
    void notifier
      .notify(winner === 0 ? m.player0 : m.player1, {
        title: `💰 You won ${human(prizeWei)} — paid out`,
        body: `Your winnings from match #${key} are in your wallet. You also scored league points.`,
        url: "/compete",
        tag: `awale-paid-${key}`,
      })
      .catch(() => {});
    // rake was actually paid on this game — it can convert a pending referral
    // (draws refund without rake and must not, or referrals become free)
    await convertReferral(m.player0).catch(() => {});
    await convertReferral(m.player1).catch(() => {});
  }
  recordGameResult([m.player0, m.player1], winner);
  console.log(`[settled] counted match ${key} (winner=${winner})`);
}

publicClient.watchContractEvent({
  address: ESCROW,
  abi: matchEscrowAbi,
  eventName: "MatchSettled",
  onLogs: (logs) => {
    for (const log of logs) {
      const { args, blockNumber } = log as unknown as {
        args: { matchId?: bigint; winner?: number; prize?: bigint };
        blockNumber?: bigint;
      };
      if (args.matchId === undefined || args.winner === undefined) continue;
      void onSettled(args.matchId, Number(args.winner), args.prize ?? 0n, new Date())
        .then(() => (blockNumber !== undefined ? ledger.setLastBlock(blockNumber) : undefined))
        .catch((e) => console.warn(`[settled] match ${args.matchId} not recorded: ${(e as Error).message}`));
    }
  },
});

// Backfill the deploy gap: events emitted while the server was down were
// invisible to the watcher, silently under-counting the league on every
// deploy. Resume from the last processed block (capped to a lookback window
// so a long-dead ledger doesn't trigger a full-chain scan); the ledger's
// claim() makes overlap harmless. League credits use the block's timestamp so
// a game settled Sunday 23:59 lands in the right week even if the server only
// reads it Monday.
const SETTLED_EVENT = parseAbiItem("event MatchSettled(uint256 indexed matchId, uint8 winner, uint256 prize)");
const BACKFILL_BLOCKS = BigInt(process.env.LEAGUE_BACKFILL_BLOCKS ?? "100000");
const BACKFILL_STEP = 5_000n;
async function backfillSettled(): Promise<void> {
  const latest = await publicClient.getBlockNumber();
  const floor = latest > BACKFILL_BLOCKS ? latest - BACKFILL_BLOCKS : 0n;
  const last = await ledger.lastBlock();
  let from = last !== null && last + 1n > floor ? last + 1n : floor;
  if (from > latest) return;
  const blockTimes = new Map<bigint, Date>();
  let seen = 0;
  for (let b = from; b <= latest; b += BACKFILL_STEP) {
    const to = b + BACKFILL_STEP - 1n < latest ? b + BACKFILL_STEP - 1n : latest;
    const logs = await publicClient.getLogs({ address: ESCROW, event: SETTLED_EVENT, fromBlock: b, toBlock: to });
    for (const log of logs) {
      const { matchId, winner, prize } = log.args;
      if (matchId === undefined || winner === undefined) continue;
      let at = blockTimes.get(log.blockNumber);
      if (!at) {
        const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
        at = new Date(Number(block.timestamp) * 1000);
        blockTimes.set(log.blockNumber, at);
      }
      await onSettled(matchId, Number(winner), prize ?? 0n, at);
      seen++;
    }
    await ledger.setLastBlock(to);
  }
  // the 5-min sweeps are usually empty — only narrate the interesting ones
  if (seen > 0 || last === null) console.log(`[settled] backfill: blocks ${from} → ${latest}, ${seen} settlement(s)`);
}
// The poller is the guarantee, the live watcher just the accelerator: if
// watchContractEvent ever fights the RPC (forno has rejected filter methods
// before), settlements would silently stop counting until the next deploy.
// Resuming from lastBlock makes each sweep one cheap getLogs over new blocks.
let backfillRunning = false;
async function backfillTick(): Promise<void> {
  if (backfillRunning) return;
  backfillRunning = true;
  try {
    await backfillSettled();
  } catch (e) {
    console.warn(`[settled] backfill failed: ${(e as Error).message}`);
  } finally {
    backfillRunning = false;
  }
}
{
  void backfillTick();
  const bt = setInterval(() => void backfillTick(), 5 * 60_000);
  if ("unref" in bt) bt.unref();
}

// League prizes are paid from the operator wallet (the rake itself accrues in
// the Treasury; ops keeps the operator funded to cover the pool share).
// Returns the winners actually paid — anything unpaid rolls into next week.
async function leaguePayout(token: Address, winners: LeagueWinner[]): Promise<LeagueWinner[]> {
  if (!(SIGNER && SIGNER.startsWith("0x") && SIGNER.length === 66)) {
    console.warn("[league] no operator signer — pool carried to next week");
    return [];
  }
  const wallet = createWalletClient({
    chain: chainFor(CHAIN_ID),
    transport: http(RPC_URL),
    account: operatorAccount!,
  });
  const paid: LeagueWinner[] = [];
  for (const w of winners) {
    // Anti-sybil: once Self verification is configured, a wallet must belong
    // to a verified human to be *paid* (playing stays ungated — no funnel
    // friction; sniping the pot with throwaway wallets stops working).
    if (selfVerifier && !(await personhood.isVerified(w.address))) {
      console.log(`[league] prize for ${w.address} withheld — not verified; carried over`);
      void notifier
        .notify(w.address, {
          title: "Verify to claim league prizes",
          body: "You placed in the weekly league, but prizes need a one-time identity check. Verify in the app to be paid next time.",
          url: "/compete",
          tag: "awale-league-verify",
        })
        .catch(() => {});
      continue;
    }
    try {
      const hash = await wallet.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "transfer",
        args: [w.address, BigInt(w.amountWei)],
        ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY } : {}),
      } as Parameters<typeof wallet.writeContract>[0]);
      await publicClient.waitForTransactionReceipt({ hash });
      paid.push(w);
      console.log(`[league] prize ${w.amountWei} → ${w.address} (${hash})`);
    } catch (e) {
      console.warn(`[league] prize to ${w.address} failed (carried over): ${(e as Error).message}`);
    }
  }
  return paid;
}

async function leagueTick(): Promise<void> {
  const result = await league.rollover(leaguePayout);
  if (!result) return;
  console.log(`[league] week ${result.week} closed — pool ${result.poolWei}, ${result.winners.length} paid`);
  result.winners.forEach((w, i) => {
    void notifier
      .notify(w.address, {
        title: "You won the weekly league! 🏆",
        body: `You finished #${i + 1} this week — your prize just landed in your wallet.`,
        url: "/compete",
        tag: `awale-league-${result.week}`,
      })
      .catch(() => {});
  });
}
{
  const tick = () => void leagueTick().catch((e) => console.warn(`[league] tick failed: ${(e as Error).message}`));
  tick(); // adopt/settle the open week immediately on boot, not up to 5 min later
  const lt = setInterval(tick, 5 * 60_000);
  if ("unref" in lt) lt.unref();
}

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
