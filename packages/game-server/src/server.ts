// Socket.IO transport (integration layer).
//
// Thin wiring from socket events to the GameHub. All authoritative logic lives
// in the hub/Match/engine; this file only translates messages.
//
// Protocol (client -> server):
//   "queue"      { address, elo, mode? }                    join matchmaking ("casual"
//                                                            by default; "ranked"/"cash"
//                                                            require personhood verification)
//   "watch"          { matchId, player? }                   subscribe to a match room
//   "move"           { matchId, player, house, signature } a session-key-signed move
//   "result-sig"     { matchId, signature }                a session-key-signed result
//   "resign"         { matchId, player, signature }        concede; opponent wins
//   "draw-offer"      { matchId, player, signature }        offer a mutual draw
//   "draw-accept"     { matchId, player, signature }        accept the pending draw offer
//   "get-transcript"  { matchId }                           fetch the signed transcript (still
//                                                           in memory) to decide whether to dispute
// Server -> client:
//   "matched"        { opponent }
//   "state"          { matchId, state, ply }
//   "gameover"       { matchId, winner }
//   "settled"        { matchId }
//   "draw-offer"     { matchId, from }                      relayed to the opponent
//   "claim-eligible" { matchId, winner, transcript }        staked only — the opponent's
//                                                           move-clock ran out, or a natural
//                                                           ending never settled; whoever the
//                                                           `winner` is can call proposeResult
//   "transcript"     { matchId, transcript }                reply to "get-transcript"
//   "error"          { message }
//
// Move-clock rule (one mental model everywhere): a player has a fixed window
// to play their turn. Miss it and you forfeit. For casual play the server
// declares the winner directly (no stake, no signature needed). For staked
// play the server never decides who loses a stake — it only signals; a
// player still has to claim on-chain via MatchEscrow.proposeResult (from
// their own wallet), which opens the existing challenge window before paying
// out. See docs/deployment.md and MatchEscrow.sol for that on-chain half.

import type { Server, Socket } from "socket.io";
import type { Address, Hex } from "viem";
import { GameHub } from "./hub.js";
import { Matchmaker, type Pairing } from "./matchmaking.js";
import { bandFor, resolveStake } from "./stake-bands.js";
import { DEFAULT_ELO } from "./store/types.js";
import type { Match, Transcript } from "./match.js";
import type { SettlementCoordinator } from "./settlement-coordinator.js";
import { assertPersonhood } from "./personhood/gate.js";
import type { PersonhoodRegistry, PlayMode } from "./personhood/types.js";
import type { GameState } from "../../engine/src/awale.js";

export interface ServerDeps {
  hub: GameHub;
  /** Collects result signatures and submits settleSigned (optional). */
  coordinator?: SettlementCoordinator;
  /** Called when a game ends so the app can react. */
  onGameOver?: (matchId: bigint, winner: number) => void;
  /** Gates ranked/cash matchmaking behind Self proof-of-personhood (optional). */
  personhood?: PersonhoodRegistry;
  /** Domain for casual (off-chain) quick-match move signatures. */
  casualCtx?: { chainId: bigint; verifier: Address };
  /** Per-turn move-clock for live play (default 2 minutes). */
  turnClockMs?: number;
  /** Blitz: total thinking time per player for live matches (default 3 min) —
   *  bounds a game to ~6 minutes, matching the audience's short-round rhythm. */
  blitzClockMs?: number;
  /** How long to wait for the two-signature fast path before telling a staked
   *  winner to self-claim on-chain (default 45s). */
  unsettledWatchdogMs?: number;
  /** Called when a casual quick-match ends, with both wallet addresses —
   *  feeds Elo + win/played counters on the durable player profile. */
  onResult?: (players: [Address, Address], winner: number) => void;
  /** Server-side rating lookup for matchmaking. The client also sends an elo
   *  in "queue", but that value is attacker-chosen — never trust it when the
   *  profile can answer. */
  eloOf?: (address: Address) => Promise<number | null>;
  /** Rebuild a staked match from its on-chain record when the hub doesn't
   *  have it (missed join event, server restart). Without this, two players
   *  fully staked into an Active match stare at "Connected" forever. */
  openFromChain?: (matchId: bigint) => Promise<void>;
  /** One reconnection grace per seat per match: if the player on the move
   *  drops (mobile data blink — the norm for the target market), the forfeit
   *  timer is pushed back this much once instead of firing on time (0 = off,
   *  default 45s). Their blitz bank keeps draining — this only prevents the
   *  *forfeit* from landing while they can't see the board. */
  reconnectGraceMs?: number;
  /** Skill window for CASH quick-match (P0-2). Money is zero-sum and raked, so
   *  a beginner vs the server's best player is the product's biggest churn
   *  risk — cash pairing now respects Elo. Defaults: base gap 200, +15/s,
   *  pair-anyone backstop at 120s (fairness degrades to liquidity, never
   *  deadlock, on a thin player base). */
  cashMatchmaking?: {
    baseWindow?: number;
    windowGrowthPerSec?: number;
    pairAnyoneAfterSec?: number;
    /** injectable clock — test-only; defaults to Date.now in production */
    now?: () => number;
  };
  /** Token decimals for stake-band boundaries (P0-3). Default 18 (aUSD). */
  stakeDecimals?: number;
}

/** A fresh, collision-free id for an off-chain casual match (also used for async). */
function casualMatchId(): bigint {
  return (1n << 200n) + BigInt(Math.floor(Math.random() * 1e15)) * 1000n + BigInt(Math.floor(Math.random() * 1000));
}

// Any matchId in this range is a synthetic off-chain id (casual quick-match or
// async) — never a real MatchEscrow id, which comes from the contract's small,
// sequential nextMatchId() counter. This is how the server tells "no money
// riding on this" apart from "money riding on this" without extra bookkeeping.
const CASUAL_ID_FLOOR = 1n << 200n;
function isCasualMatch(matchId: bigint): boolean {
  return matchId >= CASUAL_ID_FLOOR;
}

const DEFAULT_TURN_CLOCK_MS = 30_000; // per-move backstop: the client auto-plays at 10s, this only fires for a truly-gone client
// The total per-player "blitz" clock is retired for money/live play: games now
// run on a 10s-per-move rhythm with client auto-play, so there is no total-time
// flag-fall (which was what produced the 10-minute frozen settlement screen).
// undefined = no total clock.
const DEFAULT_UNSETTLED_WATCHDOG_MS = 45_000;
const DEFAULT_RECONNECT_GRACE_MS = 45_000;

/** What `attachSocketIO` hands back so the runtime can drive periodic work.
 *  Additive: existing callers that ignore the return value still compile. */
export interface SocketHandle {
  /** Pair every currently-compatible pair of waiting players (P0-1). Called on
   *  an interval from main.ts so two people already in the queue match once
   *  their windows overlap, without needing a third arrival. */
  sweepQueues(): void;
}

export function attachSocketIO(io: Server, deps: ServerDeps): SocketHandle {
  const { hub } = deps;
  const TURN_CLOCK_MS = deps.turnClockMs ?? DEFAULT_TURN_CLOCK_MS;
  const BLITZ_CLOCK_MS = deps.blitzClockMs; // undefined = untimed total (per-move clock governs)
  const UNSETTLED_WATCHDOG_MS = deps.unsettledWatchdogMs ?? DEFAULT_UNSETTLED_WATCHDOG_MS;
  const RECONNECT_GRACE_MS = deps.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
  const STAKE_DECIMALS = deps.stakeDecimals ?? 18; // aUSD; overridden per deployment

  // One move-clock timer per live match, keyed by room id (matchId.toString()).
  const turnClockTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Casual quick-match seats by room id — the wallet addresses behind player 0
  // and 1, known only at pairing time. Lets a finished game feed the durable
  // player profiles (Elo, played/won). Entries die with the match.
  const casualPlayers = new Map<string, [Address, Address]>();

  // Reconnection grace bookkeeping: which seat each socket watches (declared
  // via "watch"), and which seats have already spent their one grace.
  const socketSeats = new Map<string, { roomId: string; player: 0 | 1 }>();
  const graceUsed = new Set<string>(); // `${roomId}:${player}`

  // Staked quick-match: pick a stake, tap once, get paired. The #1 friction
  // in real two-player tests was both friends CREATING a match and waiting in
  // parallel rooms forever. The server now pairs money players like casual
  // ones — first waiter becomes the creator, second the joiner — and
  // choreographs create → join so nobody ever sees a lobby, an invite link
  // or a match number. (The chain still holds the money; the server only
  // coordinates who does which transaction.)
  // Cash pairing now runs through the SAME Matchmaker as casual — one logical
  // queue per stake bucket — so it respects Elo instead of pairing the first
  // two wallets that happen to name the same amount (P0-2). `cashMeta` carries
  // the per-socket stake/token needed to build the match and to find which
  // pool to remove a leaver from.
  const cashPools = new Map<string, Matchmaker>(); // poolKey → skill queue
  const cashMeta = new Map<
    string,
    { address: Address; stake: bigint; token: Address; poolKey: string }
  >();
  const cashPairs = new Map<
    string, // creator's socket id
    { joinerSocket: string; stakeKey: string; timer: ReturnType<typeof setTimeout>; matchId?: string }
  >();

  function cashPool(poolKey: string): Matchmaker {
    let pool = cashPools.get(poolKey);
    if (!pool) {
      pool = new Matchmaker({
        baseWindow: deps.cashMatchmaking?.baseWindow ?? 200,
        windowGrowthPerSec: deps.cashMatchmaking?.windowGrowthPerSec ?? 15,
        pairAnyoneAfterSec: deps.cashMatchmaking?.pairAnyoneAfterSec ?? 120,
        now: deps.cashMatchmaking?.now,
      });
      cashPools.set(poolKey, pool);
    }
    return pool;
  }

  /** Drop a socket from whatever cash pool it's waiting in (re-queue, cancel,
   *  disconnect). Idempotent. */
  function removeFromCash(socketId: string): void {
    const meta = cashMeta.get(socketId);
    if (!meta) return;
    cashMeta.delete(socketId);
    cashPools.get(meta.poolKey)?.remove(socketId);
  }

  /** Turn a cash pairing into the create→join choreography. The earlier waiter
   *  (`pairing.a`) is the creator — unchanged from the old first-waiter rule.
   *  The 240s timer and the auto-cancel/refund path are untouched; only WHO
   *  gets paired changed. The pair settles at the LOWER of the two requested
   *  stakes (P0-3) — the creator creates the on-chain match at that amount and
   *  the joiner stakes the same, both shown it in cash-matched. Within a v1
   *  (exact) pool the two stakes are equal, so this collapses to the old
   *  behaviour for old clients. */
  function startCashPairing(pairing: Pairing, _poolKey: string): void {
    const creatorMeta = cashMeta.get(pairing.a.id);
    const joinerMeta = cashMeta.get(pairing.b.id);
    cashMeta.delete(pairing.a.id);
    cashMeta.delete(pairing.b.id);
    if (!creatorMeta || !joinerMeta) return; // a socket vanished between pair and dispatch
    const resolved = resolveStake(creatorMeta.stake, joinerMeta.stake);
    const stakeWei = resolved.toString();
    const stakeKey = `${creatorMeta.token.toLowerCase()}:${stakeWei}`;
    // give the pair 4 minutes to get both stakes on-chain (measured ~50s/tx on
    // forno + human wallet confirmations — 120s was provably too tight)
    const timer = setTimeout(() => abortCashPair(pairing.a.id, "Setup took too long — try again."), 240_000);
    cashPairs.set(pairing.a.id, { joinerSocket: pairing.b.id, stakeKey, timer });
    io.to(pairing.a.id).emit("cash-matched", { role: "create", opponent: joinerMeta.address, stakeWei });
    io.to(pairing.b.id).emit("cash-matched", { role: "join", opponent: creatorMeta.address, stakeWei });
  }

  function abortCashPair(creatorSocket: string, reason: string): void {
    const pair = cashPairs.get(creatorSocket);
    if (!pair) return;
    clearTimeout(pair.timer);
    cashPairs.delete(creatorSocket);
    io.to(creatorSocket).emit("cash-abort", { reason });
    io.to(pair.joinerSocket).emit("cash-abort", { reason });
  }

  function clearTurnClock(roomId: string): void {
    const t = turnClockTimers.get(roomId);
    if (t) {
      clearTimeout(t);
      turnClockTimers.delete(roomId);
    }
  }

  /** ms until the current mover times out: the per-move window or their total
   *  blitz bank, whichever runs dry first. */
  function msUntilExpiry(m: Match): number {
    const perMove = TURN_CLOCK_MS - m.msSinceTurnStart();
    const total = m.clockRemainingMs(m.turn as 0 | 1);
    return Math.max(0, total === null ? perMove : Math.min(perMove, total));
  }

  /** (Re)schedule the clock against however much time the current mover has left. */
  function scheduleTurnClock(matchId: bigint, roomId: string, m: Match): void {
    const timer = setTimeout(() => onTurnClockExpired(matchId, roomId), msUntilExpiry(m));
    if ("unref" in timer) timer.unref?.();
    turnClockTimers.set(roomId, timer);
  }

  /** Idempotent: arms the clock the first time anyone touches a match (e.g. on
   *  "watch"), including the catch-up case where it should already have fired. */
  function armTurnClockIfNeeded(matchId: bigint, roomId: string): void {
    if (turnClockTimers.has(roomId)) return;
    const m = hub.get(matchId);
    if (!m || m.over) return;
    scheduleTurnClock(matchId, roomId, m);
  }

  /** Always resets — used after a move, since a fresh turn just started. */
  function rearmTurnClock(matchId: bigint, roomId: string): void {
    clearTurnClock(roomId);
    const m = hub.get(matchId);
    if (!m || m.over) return;
    scheduleTurnClock(matchId, roomId, m);
  }

  function onTurnClockExpired(matchId: bigint, roomId: string): void {
    turnClockTimers.delete(roomId);
    const m = hub.get(matchId);
    if (!m || m.over) return;
    if (msUntilExpiry(m) > 0) {
      // a race with a move that landed just as this fired — reschedule defensively
      scheduleTurnClock(matchId, roomId, m);
      return;
    }
    const timedOutPlayer = m.turn as 0 | 1;
    // Same path for casual AND staked now: forfeit the timed-out player and
    // announce game-over. For a staked match this drives the two-signature
    // fast path (settleSigned, instant) — the opponent is normally still
    // here to co-sign — with the challenge-window claim only as the watchdog
    // fallback when they've truly disconnected. This is what killed the
    // 10-minute frozen screen after a timeout. In practice the client's own
    // 10s-per-move auto-play means the game usually reaches a natural end
    // and this server backstop only fires on a genuinely abandoned game.
    try {
      const state = hub.forfeit(matchId, timedOutPlayer);
      announceGameOver(matchId, roomId, state);
    } catch {
      /* already resolved some other way between the check and the call */
    }
  }

  /** Socket.IO's encoder can't serialize a bigint — send the transcript as JSON-safe strings. */
  function serializeTranscript(t: Transcript) {
    return { ...t, matchId: t.matchId.toString() };
  }

  /** Live blitz clocks for the state payloads (null for untimed matches). */
  function clocksOf(m: Match): [number, number] | null {
    const c0 = m.clockRemainingMs(0);
    const c1 = m.clockRemainingMs(1);
    return c0 === null || c1 === null ? null : [c0, c1];
  }

  function emitClaimEligible(roomId: string, winner: 0 | 1 | 2, transcript: Transcript): void {
    io.to(roomId).emit("claim-eligible", { matchId: roomId, winner, transcript: serializeTranscript(transcript) });
  }

  // Broadcast a just-finished match's state/gameover. Shared by every ending —
  // natural (move-driven), resign, and mutual draw. Casual matches are fully
  // resolved off-chain, so free them from memory immediately; staked matches
  // stay so a claim (or a settleSigned still landing) can read the transcript,
  // and get a short watchdog: if the two-signature fast path hasn't closed the
  // match within UNSETTLED_WATCHDOG_MS, tell the room to self-claim.
  function announceGameOver(matchId: bigint, roomId: string, state: GameState): void {
    clearTurnClock(roomId);
    graceUsed.delete(`${roomId}:0`);
    graceUsed.delete(`${roomId}:1`);
    const gm = hub.get(matchId);
    io.to(roomId).emit("state", { matchId: roomId, state, ply: gm?.ply ?? 0, clocks: gm ? clocksOf(gm) : null });
    io.to(roomId).emit("gameover", { matchId: roomId, winner: state.winner });
    deps.onGameOver?.(matchId, state.winner);

    const players = casualPlayers.get(roomId);
    if (players) {
      casualPlayers.delete(roomId);
      deps.onResult?.(players, state.winner);
    }

    if (isCasualMatch(matchId)) {
      hub.close(matchId);
      return;
    }
    const timer = setTimeout(() => {
      const m = hub.get(matchId); // still present => settleSigned never closed it
      if (m) emitClaimEligible(roomId, state.winner as 0 | 1 | 2, m.transcript());
    }, UNSETTLED_WATCHDOG_MS);
    if ("unref" in timer) timer.unref?.();
  }

  // Turn a pairing into a live table + client notifications. Extracted so the
  // periodic sweep (which pairs two ALREADY-waiting players) drives exactly the
  // same path as an enqueue-time match — the only reason two queued sockets now
  // get "matched" without a third joiner.
  function completePairing(pairing: Pairing): void {
    // Casual quick-match: open an off-chain match and tell each player their
    // role so both clients can join and play immediately (no stake/settle).
    if (deps.casualCtx && pairing.a.sessionPubKey && pairing.b.sessionPubKey) {
      const matchId = casualMatchId();
      const startTurn = (Math.random() < 0.5 ? 0 : 1) as 0 | 1;
      hub.open({
        matchId,
        chainId: deps.casualCtx.chainId,
        verifier: deps.casualCtx.verifier,
        sessions: [pairing.a.sessionPubKey, pairing.b.sessionPubKey],
        startTurn,
        clockMs: BLITZ_CLOCK_MS,
      });
      const m = hub.get(matchId)!;
      const id = matchId.toString();
      casualPlayers.set(id, [pairing.a.address, pairing.b.address]); // role 0 = a, role 1 = b
      armTurnClockIfNeeded(matchId, id);
      io.to(pairing.a.id).emit("matched", { matchId: id, role: 0, opponent: pairing.b.address, casual: true });
      io.to(pairing.b.id).emit("matched", { matchId: id, role: 1, opponent: pairing.a.address, casual: true });
      io.to(pairing.a.id).emit("state", { matchId: id, state: m.state, ply: 0, clocks: clocksOf(m) });
      io.to(pairing.b.id).emit("state", { matchId: id, state: m.state, ply: 0, clocks: clocksOf(m) });
      return;
    }

    io.to(pairing.a.id).emit("matched", { opponent: pairing.b.address });
    io.to(pairing.b.id).emit("matched", { opponent: pairing.a.address });
  }

  io.on("connection", (socket: Socket) => {
    socket.on(
      "queue",
      async (msg: { address: Address; elo: number; mode?: PlayMode; sessionPubKey?: Address }) => {
        const mode = msg.mode ?? "casual";
        if (deps.personhood) {
          try {
            await assertPersonhood(deps.personhood, msg.address, mode);
          } catch (err) {
            socket.emit("error", { message: (err as Error).message });
            return;
          }
        }
        // the profile's rating wins over whatever the client claimed
        const serverElo = deps.eloOf ? await deps.eloOf(msg.address).catch(() => null) : null;
        const pairing = hub.queue({
          id: socket.id,
          address: msg.address,
          elo: serverElo ?? msg.elo,
          sessionPubKey: msg.sessionPubKey,
        });
        if (pairing) completePairing(pairing);
      },
    );

    // --- staked quick-match choreography ---
    // `v: 2` marks a client that CREATES the match at the resolved (lower)
    // stake carried in cash-matched. Only such clients may be paired
    // cross-stake within a band (P0-3): a v1 client ignores that field and
    // creates at its own amount, so it stays in an EXACT-stake bucket where
    // the resolved stake equals what it typed. (Transient during rollout: a
    // v1 and a v2 wanting the same amount sit in different buckets until the
    // v1 client refreshes to v2. No money is at risk — worst case is they
    // don't meet, exactly as two v1 clients at different stakes wouldn't.)
    socket.on("cash-queue", async (msg: { address: Address; stakeWei: string; token: Address; v?: number }) => {
      if (!msg?.address || !msg.stakeWei || !msg.token) return;
      let stake: bigint;
      try {
        stake = BigInt(msg.stakeWei);
      } catch {
        return; // malformed amount
      }
      if (stake <= 0n) return;
      // re-queue idempotency: drop any prior waiting entry for this socket
      removeFromCash(socket.id);
      const token = msg.token.toLowerCase();
      const poolKey =
        msg.v && msg.v >= 2
          ? `${token}:band:${bandFor(stake, STAKE_DECIMALS)}` // cross-stake within a band
          : `${token}:exact:${msg.stakeWei}`; // old client: exact stake only
      // rating from the server profile only — never the client (there's no
      // client-supplied elo on cash-queue, and we wouldn't trust one)
      const elo = (deps.eloOf ? await deps.eloOf(msg.address).catch(() => null) : null) ?? DEFAULT_ELO;
      cashMeta.set(socket.id, { address: msg.address, stake, token: msg.token, poolKey });
      const pairing = cashPool(poolKey).enqueue({ id: socket.id, address: msg.address, elo });
      if (pairing) startCashPairing(pairing, poolKey);
    });

    socket.on("cash-cancel", () => removeFromCash(socket.id));

    // the creator's stake landed — hand the joiner the real match id. The
    // pair stays open until the joiner confirms: if they fail, the creator
    // is still connected and can auto-cancel for an instant refund.
    socket.on("cash-created", (msg: { matchId: string }) => {
      const pair = cashPairs.get(socket.id);
      if (!pair || !msg?.matchId) return;
      pair.matchId = msg.matchId;
      // include token + stake so the joiner never has to READ the fresh match
      // from a possibly-stale RPC node before staking
      const [token, stakeWei] = pair.stakeKey.split(":");
      io.to(pair.joinerSocket).emit("cash-join", { matchId: msg.matchId, token, stakeWei });
    });

    // the joiner's stake landed too — table is fully set, release both.
    // Also open the board PROACTIVELY: we know the join just confirmed, so
    // don't wait for the event watchers to notice (that passive leg measured
    // 68s in the e2e) — finalize the first-move flip and hydrate now.
    socket.on("cash-joined", () => {
      for (const [creator, pair] of cashPairs) {
        if (pair.joinerSocket === socket.id) {
          clearTimeout(pair.timer);
          cashPairs.delete(creator);
          io.to(creator).emit("cash-ready", { matchId: pair.matchId ?? "" });
          if (pair.matchId && deps.openFromChain) {
            const id = BigInt(pair.matchId);
            // one patient hydration (it polls through the RPC's stale window
            // internally); a late second pass as a safety net
            void deps.openFromChain(id).catch(() => {});
            setTimeout(() => void deps.openFromChain?.(id).catch(() => {}), 75_000);
          }
          return;
        }
      }
    });

    // either side's transaction failed — release both cleanly
    socket.on("cash-failed", () => {
      if (cashPairs.has(socket.id)) {
        abortCashPair(socket.id, "Your opponent couldn't stake — searching again.");
        return;
      }
      for (const [creator, pair] of cashPairs) {
        if (pair.joinerSocket === socket.id) {
          abortCashPair(creator, "Your opponent couldn't stake. Your match stays open — share the invite or cancel it.");
          return;
        }
      }
    });

    // subscribe to a match's room and get its current state + ply. Also arms
    // (or catches up) the move-clock — this is how a staked match's clock
    // starts, since it's opened directly by the on-chain listener, not here.
    // `player` (optional) declares which seat this socket is — that's what
    // lets the disconnect handler grant the seat its reconnection grace.
    socket.on("watch", async (msg: { matchId: string; player?: 0 | 1 }) => {
      socket.join(msg.matchId);
      const matchId = BigInt(msg.matchId);
      let m = hub.get(matchId);
      // a staked match missing from the hub gets rebuilt from the chain —
      // the client re-watches every few seconds, so a not-ready-yet
      // hydration (reveal block pending) resolves on a later attempt
      if (!m && !isCasualMatch(matchId) && deps.openFromChain) {
        await deps.openFromChain(matchId).catch(() => {});
        m = hub.get(matchId);
      }
      if (m) socket.emit("state", { matchId: msg.matchId, state: m.state, ply: m.ply, clocks: clocksOf(m) });
      if (msg.player === 0 || msg.player === 1) socketSeats.set(socket.id, { roomId: msg.matchId, player: msg.player });
      armTurnClockIfNeeded(matchId, msg.matchId);
    });

    // A client that reconnects after missing a live "claim-eligible" broadcast
    // (e.g. it discovers on-chain that a result was proposed while it was away)
    // asks for the signed transcript directly so it can decide whether to
    // dispute. Only available while the match is still tracked in memory.
    socket.on("get-transcript", (msg: { matchId: string }) => {
      const t = hub.transcript(BigInt(msg.matchId));
      if (t) socket.emit("transcript", { matchId: msg.matchId, transcript: serializeTranscript(t) });
      else socket.emit("error", { message: "transcript no longer available" });
    });

    socket.on(
      "move",
      async (msg: { matchId: string; player: 0 | 1; house: number; signature: Hex }) => {
        try {
          const matchId = BigInt(msg.matchId);
          // a fallen flag ends the mover's right to play: accepting moves
          // after claim-eligible was broadcast lets the transcript diverge
          // from the claim already in flight
          const pre = hub.get(matchId);
          if (pre && !pre.over && pre.turn === msg.player && pre.flagFallen()) {
            socket.emit("error", { message: "Time is up — this game can now be claimed." });
            return;
          }
          const state = await hub.move(matchId, msg.player, msg.house, msg.signature);
          if (state.over) {
            announceGameOver(matchId, msg.matchId, state);
          } else {
            const mm = hub.get(matchId);
            io.to(msg.matchId).emit("state", { matchId: msg.matchId, state, ply: mm?.ply ?? 0, clocks: mm ? clocksOf(mm) : null });
            rearmTurnClock(matchId, msg.matchId);
          }
        } catch (err) {
          socket.emit("error", { message: (err as Error).message });
        }
      },
    );

    // collect a session-key-signed result; settle once both players have signed
    socket.on("result-sig", async (msg: { matchId: string; signature: Hex }) => {
      if (!deps.coordinator) return;
      try {
        const matchId = BigInt(msg.matchId);
        const outcome = await deps.coordinator.submit(hub, matchId, msg.signature);
        if (outcome === "settled") io.to(msg.matchId).emit("settled", { matchId: msg.matchId });
      } catch (err) {
        socket.emit("error", { message: (err as Error).message });
      }
    });

    // concede: opponent wins, no negotiation needed — only the resigner's own
    // signature is required.
    socket.on("resign", async (msg: { matchId: string; player: 0 | 1; signature: Hex }) => {
      try {
        const matchId = BigInt(msg.matchId);
        const state = await hub.resign(matchId, msg.player, msg.signature);
        announceGameOver(matchId, msg.matchId, state);
      } catch (err) {
        socket.emit("error", { message: (err as Error).message });
      }
    });

    // offer a mutual draw — relayed to the opponent, who accepts or ignores it
    socket.on("draw-offer", async (msg: { matchId: string; player: 0 | 1; signature: Hex }) => {
      try {
        const matchId = BigInt(msg.matchId);
        await hub.offerDraw(matchId, msg.player, msg.signature);
        socket.to(msg.matchId).emit("draw-offer", { matchId: msg.matchId, from: msg.player });
      } catch (err) {
        socket.emit("error", { message: (err as Error).message });
      }
    });

    // accept the opponent's pending draw offer — ends the match in a draw
    socket.on("draw-accept", async (msg: { matchId: string; player: 0 | 1; signature: Hex }) => {
      try {
        const matchId = BigInt(msg.matchId);
        const state = await hub.acceptDraw(matchId, msg.player, msg.signature);
        announceGameOver(matchId, msg.matchId, state);
      } catch (err) {
        socket.emit("error", { message: (err as Error).message });
      }
    });

    socket.on("disconnect", () => {
      hub.matchmaker.remove(socket.id);
      // staked quick-match cleanup: leave the queue; abort a half-built pair
      removeFromCash(socket.id);
      if (cashPairs.has(socket.id)) abortCashPair(socket.id, "Your opponent disconnected — searching again.");
      for (const [creator, pair] of cashPairs) {
        if (pair.joinerSocket === socket.id) abortCashPair(creator, "Your opponent disconnected. Your match stays open — share the invite or cancel it.");
      }
      // The move-clock is driven by match state, not connection state — with
      // ONE exception: if the player on the move just dropped, push their
      // forfeit timer back once (their blitz bank keeps draining regardless).
      // A mobile-data blink is routine for this audience; losing a staked
      // game to 40 seconds of tunnel reads as theft, not as a rule.
      const seat = socketSeats.get(socket.id);
      socketSeats.delete(socket.id);
      if (!seat || RECONNECT_GRACE_MS <= 0) return;
      const m = hub.get(BigInt(seat.roomId));
      if (!m || m.over || m.turn !== seat.player) return;
      const key = `${seat.roomId}:${seat.player}`;
      if (graceUsed.has(key)) return;
      graceUsed.add(key);
      clearTurnClock(seat.roomId);
      const timer = setTimeout(
        () => onTurnClockExpired(BigInt(seat.roomId), seat.roomId),
        msUntilExpiry(m) + RECONNECT_GRACE_MS,
      );
      if ("unref" in timer) timer.unref?.();
      turnClockTimers.set(seat.roomId, timer);
    });
  });

  return {
    sweepQueues() {
      for (const pairing of hub.matchmaker.sweep()) completePairing(pairing);
      // cash pools too (P0-2): two waiters in the same stake bucket pair once
      // their skill windows overlap, without a third arrival
      for (const [poolKey, pool] of cashPools) {
        for (const pairing of pool.sweep()) startCashPairing(pairing, poolKey);
      }
    },
  };
}
