# Tournaments (Sit-and-Go) — implementation milestone

**Date:** 2026-06-22 · **Branch:** feat/contracts-rules-engine

The revenue engine from [economic-model.md](economic-model.md) axis ①: opt-in
Sit-and-Go tournaments with an entry fee, a fixed payout table, and a protocol cut
to the Treasury — plus sponsor-funded free-rolls as the anti-churn / acquisition
valve. Reuses the existing match plumbing; only the money layer is new.

## What shipped (built, tested, compiling)

### 1. Contract — `contracts/src/TournamentEscrow.sol`  (15 Foundry tests)
- Entry-fee custody into a per-tournament prize pool; `fund()` lets sponsors/Treasury
  top up free-rolls (entryFee = 0).
- Payout table **fixed at creation** (sums to 100% of the distributable pool); the
  operator only submits the **ordered winners** — never the amounts.
- `cutBps` (≤ 20% hard cap) skimmed to the Treasury at `finalize`; rounding dust and
  unfilled-place shares also sweep to Treasury.
- `refund()` — permissionless once under-filled past the join deadline, or once the
  operator misses the refund deadline → funds can never be trapped.
- Guards: allowed-tokens only, `nonReentrant`, effects-before-interactions, bounded
  field (`MAX_PLAYERS_CAP = 64`) so the refund loop is gas-safe, no duplicate/non-entrant
  winners.

**Trust model (documented in the contract):** a tournament aggregates many bracket
games, so full on-chain replay per game is impractical. A trusted `operator` (the
settlement coordinator) reports standings, but its power is bounded to *ordering of
registered entrants* + the fixed table; everything else is enforced on-chain, and the
refund path defends against an absent operator. Individual bracket games remain
session-key signed off-chain.

### 2. Server — `packages/game-server/src/tournament/`  (11 vitest)
- `bracket.ts` — pure single-elimination logic: seeding with byes for non-power-of-two
  fields, `pendingMatches` (games to run now), `reportResult` (advance), `finalStandings`
  (champion + runner-up, ordered for the on-chain table).
- `service.ts` — `TournamentService`: in-memory lobby registry → auto-starts the bracket
  when a field fills → on completion calls the injected **finalize hook**.
- `main.ts` — wired with a finalize hook that calls `TournamentEscrow.finalize` (when
  `SERVER_SIGNER_KEY` is the operator and `TOURNAMENT_ADDRESS` is set; else logs).
  Endpoints: `POST /tournaments/register`, `GET /tournaments[?open=1]`,
  `GET /tournaments/state`, `POST /tournaments/join`, `POST /tournaments/result`.

### 3. Client — Cups tab
- `lib/tournaments.ts` — list open lobbies (server), `topPrize` for the "win up to" line,
  `joinTournament` = approve entry fee → on-chain `join` → mirror POST.
- `app/tournaments/page.tsx` — the lobby: free-roll / buy-in SNG rows, seats, prize,
  Join. Graceful "coming soon" when unconfigured.
- `BottomNav` — "Cups" tab (medal icon, progressive-disclosure / advanced).
- ABI: `tournamentEscrowAbi` added to `packages/protocol/src/abis.ts`.

## The integration seam still to wire (next PR)
The bracket's `pendingMatches` are **not yet paired into live socket games**. Today a
match result reaches the server via `POST /tournaments/result` (coordinator-reported).
To make tournaments fully playable end-to-end:
1. When `TournamentService` starts/advances a bracket, create a live `Match` (or async
   game) per pending pair and route both players into it (reuses `GameHub` / `Match` /
   `ReplayVerifier`).
2. On that game settling, call `reportResult` automatically instead of via the HTTP
   endpoint.

This is deferred because live tournament games touch the socket hub and the
single-machine live-state constraint (see the Fly memory). The money + bracket + lobby
layers are complete and independently tested; the seam is the live-pairing wiring.

## Deploy
`forge script script/DeployTournament.s.sol --rpc-url $CELO_SEPOLIA_RPC --broadcast --verify`
(reuse the MatchEscrow `TREASURY`; set `OPERATOR` = the server signer). Then set
`TOURNAMENT_ADDRESS` (server) and `NEXT_PUBLIC_TOURNAMENT_ADDRESS` (app).

## Economics (from economic-model.md)
8-player SNG, 1 USDC entry, 8% cut → pool 8 USDC, Treasury 0.64, prizes 4.78 / 2.58.
Tournament take = **8% of volume**; 1v1 rake = 2.5% of volume. House edge per buy-in:
1v1 = 5%, tournament 8% = defensible given the multi-game + multiplied-prize value.
