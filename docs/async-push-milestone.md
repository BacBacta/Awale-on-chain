# Async / correspondence play + push — backend milestone

The largest retention lever (product-critique.md C2): let players **make a move and
come back later**, and get a **"your turn"** push when the opponent replies. This doc
describes the scaffold that's already in the repo and the exact steps to make it live.

## What's already built (scaffold, tested)

| Piece | File | Status |
|---|---|---|
| Match persistence interface + in-memory store | `game-server/src/persistence/store.ts` | ✅ + ready for Redis/Postgres |
| Notifier + subscription store (+ Log / WebPush) | `game-server/src/notifications/notifier.ts` | ✅ Log default; WebPush stubbed |
| Async match service (create / move / state / list) | `game-server/src/async-match.ts` | ✅ tested (`test/async-match.test.ts`) |
| HTTP API (`/async/*`, `/push/subscribe`) | `game-server/src/main.ts` | ✅ wired (in-memory + log) |
| Service worker (push → notification → focus match) | `app/public/sw.js` | ✅ |
| Client push registration | `app/src/lib/push.ts` | ✅ no-op until VAPID set |

Async play reuses the **same engine + session-key verification as live play**
(`Match.submitMove`), so an async transcript is just as disputable on-chain — no new
trust assumptions.

### HTTP API
- `GET /async/matches?address=0x…` → `{ matches: AsyncMatchSummary[] }` (with `yourTurn`)
- `GET /async/match?id=<matchId>` → replayed `{ state, turn, over, ply, players }`
- `POST /async/move` `{ matchId, player, house, signature }` → `{ state }` (verifies the
  session-key signature, applies via the engine, persists, notifies the opponent)
- `POST /push/subscribe` `{ address, subscription }` → stores the Web Push subscription

## To make it live

1. **Durable store** — implement `MatchStore` against Redis (live state) and/or Postgres
   (history): `save/get/listForPlayer/remove`. Swap `new InMemoryMatchStore()` in
   `main.ts`. (Also lets matchmaking scale past one Fly machine — see the
   `fly-matchmaking-single-machine` memory.)
2. **Web Push** — `npm i web-push` in the game-server; `web-push generate-vapid-keys`;
   set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` (server) and
   `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (app). Fill in `WebPushNotifier.notifyTurn` with
   `webpush.sendNotification(...)`, pruning 404/410 subscriptions.
3. **Client wiring** — add an "async match" surface (reuse `/matches`): list from
   `/async/matches`, open one, play a move via `POST /async/move` (signed with the
   per-match session key, now durable in `localStorage`). Add an opt-in "Enable
   notifications" that calls `registerPush(address)`.
4. **Create async matches** — extend Quick Match / cash flows with a "play async" option
   that calls `AsyncMatchService.create(...)` instead of opening a live socket room.

## Notes / caveats
- **MiniPay webview push** support must be verified on-device; fall back to in-app "your
  turn" badges (poll `/async/matches`) where push is unavailable.
- Session keys are now in `localStorage` (durable) so an async match can be resumed from
  the same device; cross-device requires re-deriving/registering a key (future).
- Notification permission must be requested from a **user gesture** (the opt-in button),
  never on load.
