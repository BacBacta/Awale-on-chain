# Network origin manifest

MiniPay's readiness review (§4, *Network Transparency*) requires a full manifest
of every URL, subdomain and origin the Mini App contacts — JS, CSS, fonts, RPCs
and APIs — so they can assess supply-chain risk. This file is that manifest.

**Scope:** the browser-side Mini App at `packages/app`. Origins contacted only by
the game server or the keeper are listed separately at the end, since they are
server-to-server and never reached from the user's device.

> Regenerate after any dependency or endpoint change:
> `grep -rhoE "https://[a-zA-Z0-9.-]+" packages/app/src packages/app/app`

## 1. Origins the app loads code or styles from

**None.** There are no third-party script tags, no CDN, and no external font
provider — no `fonts.googleapis.com`, no `unpkg`, no `jsdelivr`. All JavaScript
and CSS is bundled by Next.js and served from the app's own origin, and all
images ship from `/public` as WebP. This is the smallest supply-chain surface
the app can have, and it is deliberate: every third-party origin here would be
code executing with full access to a page that moves real money.

## 2. Origins the app makes network calls to

| Origin | Purpose | When | Configurable via |
|---|---|---|---|
| *(the app's own origin)* | app shell, assets, Next.js server actions | always | — |
| *(primary RPC)* | Celo JSON-RPC — contract reads and tx submission. Not hard-coded: it is whatever `NEXT_PUBLIC_RPC_URL` is set to, conventionally `forno.celo.org` on mainnet and `forno.celo-sepolia.celo-testnet.org` on testnet | money features | `NEXT_PUBLIC_RPC_URL` |
| `celo.drpc.org`, `rpc.ankr.com`, `1rpc.io` | mainnet RPC fallbacks — hard-coded in `src/lib/minipay.ts`, used only when the primary fails (forno rate-limits, and a dropped read used to blank the money panel) | on RPC failover | source change |
| `celo-sepolia.drpc.org`, `rpc.ankr.com` | testnet RPC fallbacks, same mechanism | testnet only | source change |
| *(game server)* | match orchestration, lobby, leaderboard, anonymous funnel counters, first-move reveal | money + async play | `NEXT_PUBLIC_SERVER_URL` |
| `link.minipay.xyz` | MiniPay deeplinks — Deposit (Add Cash) and transaction receipts | navigation only, never fetched | — |
| *(Self verifier)* | proof-of-personhood, when enabled | optional feature | `NEXT_PUBLIC_SELF_ENDPOINT` |

Notes:

- `link.minipay.xyz` is a **navigation target**, not an API: the app sets
  `window.location`, it never issues a request to it.
- `docs.celo.org` appears in source comments only. It is never contacted.
- The RPC origin is operator-configured. The table lists what ships in the
  default configuration; a self-hoster pointing `NEXT_PUBLIC_RPC_URL` elsewhere
  changes it.

## 3. Runtime dependencies that could add origins

| Package | Adds an origin? |
|---|---|
| `next`, `react`, `react-dom` | No — bundled and self-hosted |
| `viem` | Only the RPC URL it is given |
| `socket.io-client` | Only the game-server origin |
| `@selfxyz/qrcode` | Only the configured Self endpoint |

`lighthouse` is a dev-only dependency used for PageSpeed measurement and ships
no runtime code.

## 4. Server-to-server origins (not reachable from the device)

These are contacted by the game server / keeper, never by the browser, and are
listed for completeness rather than as part of the Mini App's attack surface:
the configured Celo RPC (contract reads, keeper transactions), Redis for live
match state, and Web Push endpoints (`fcm.googleapis.com` and friends) when push
notifications are enabled — those origins are chosen by the subscriber's browser
vendor, not by us.
