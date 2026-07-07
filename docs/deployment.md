# Deployment & device-test runbook

How to take Awalé from this repo to a working mini-app on **Celo Sepolia**
(chainId `11142220`), then to a physical-device test inside MiniPay. Mainnet
(`42220`) follows the same steps once an **independent external audit** is done.

> Anything that broadcasts a transaction or touches a real key is **your**
> action — this runbook tells you exactly what to run; it does not run it for you.

---

## 0. Prerequisites

- [Foundry](https://book.getfoundry.sh/) and Node 22+.
- A funded deploy key on Celo Sepolia (a little CELO for deploys + some test
  stablecoin for fees). Use a dedicated key, never a personal wallet.
- A Celoscan (Etherscan V2) API key for verification.
- The Celo Sepolia token addresses for the stablecoins you want to allow
  (USDm / USDC / USDT). Put them in env — there are no canonical constants for
  testnet baked into the deploy script.
- `ngrok` (or similar) to expose your local dev server to a phone.

---

## 1. Deploy the contracts

```bash
cd contracts
cp .env.example .env        # fill PRIVATE_KEY, OWNER, RPC, ETHERSCAN_API_KEY
./script/preflight.sh       # checks RPC, deployer balance, token addresses
forge test                  # sanity: full suite green
forge script script/Deploy.s.sol \
  --rpc-url celo_sepolia \
  --broadcast \
  --verify
```

`--rpc-url celo_sepolia` resolves via the `[rpc_endpoints]` alias in
`foundry.toml`, so you don't need the env var exported in your shell. `--verify`
uses the matching `[etherscan]` entry (needs `ETHERSCAN_API_KEY`).

> **Fastest path:** set `DEPLOY_MOCK_TOKENS=true` in `.env`. The script then
> deploys mock USDm/USDC/USDT (18/6/6 dec), allowlists them, and seeds the
> deployer with balances — so you need **only a funded key + a Celoscan key**, no
> external token addresses. (Refused on mainnet.) Otherwise set `USD*_ADDRESS`.
> `./script/preflight.sh` validates everything before you broadcast.

`Deploy.s.sol` deploys `ReplayVerifier → Treasury → MatchEscrow`, allowlists the
stablecoins from your env, sets the parameters (rake 250 bps, challenge window
10 min, TTL 1 day), and transfers ownership to `OWNER`. Record the three printed
addresses — you need them everywhere below.

> Before mainnet, set `OWNER` to a **timelock + multisig** (audit finding L-02
> on `MatchEscrow`/`Treasury`).

### Verify on Celoscan

`--verify` handles it during the run. If it fails, re-run verification with
`forge verify-contract <address> <Contract> --chain 11142220 --etherscan-api-key $KEY`.
Verified contracts with sample tx hashes are a MiniPay listing requirement.

---

## 2. Configure the off-chain services

Fastest: generate the env files straight from the broadcast —

```bash
./script/wire-env.sh        # writes packages/game-server/.env + packages/app/.env.local
```

It fills the deployed addresses (escrow, verifier, mock tokens) and leaves
`SERVER_SIGNER_KEY` as a placeholder. On real Celo, set the `feeCurrency` to the
USDC/USDT **adapter** (USDm is its own feeCurrency).

Or fill each package's `.env` from its `.env.example` by hand:

| Package | Key vars |
|---|---|
| `packages/game-server` | `RPC_URL`, `CHAIN_ID=11142220`, `ESCROW_ADDRESS`, `VERIFIER_ADDRESS`, `SERVER_SIGNER_KEY`, `FEE_CURRENCY`, `PORT` |
| `packages/app` | `STATS_RPC_URL`, `ESCROW_ADDRESS`, `ESCROW_FROM_BLOCK` (deploy block), `NEXT_PUBLIC_*` (chain id, RPC, escrow, verifier, server URL) |
| `packages/indexer` | `RPC_URL`, `ESCROW_ADDRESS`, `FROM_BLOCK` |

`FEE_CURRENCY` is the **adapter** address for USDC/USDT, or the token address for
USDm (see `packages/protocol/src/tokens.ts`).

---

## 3. Run the stack locally

```bash
# game server (matchmaking, move sequencing, settlement)
cd packages/game-server && npm ci && npm start   # add a start script wiring attachSocketIO + listener + keeper

# mini-app
cd packages/app && npm ci && npm run dev          # http://localhost:3000
```

Expose the app to your phone:

```bash
ngrok http 3000
```

---

## 4. Device test inside MiniPay (no emulators)

1. Install MiniPay on a physical Android/iOS device.
2. Enable **Developer Mode** in MiniPay settings and open the ngrok URL.
3. Verify the MiniPay-specific behaviours:
   - **Zero-click connect** — the app shows your address with no "Connect" button.
   - **No message signing** — playing never triggers a wallet signature prompt
     (moves are signed in-app with the session key).
   - **feeCurrency** — `joinMatch` / `settleSigned` succeed paying the fee in your
     stablecoin (USDC/USDT must use the adapter; never CELO in the UI).
   - **Copy lexicon** — only Deposit / Withdraw / Network fee / Stablecoin.
   - **360×640** layout, SVG board renders crisply.
   - **Deeplinks** — Add Cash on zero balance; receipt + celebration on a win.

### End-to-end cash-match flow to confirm

1. Two devices (or two MiniPay accounts) open the app.
2. Player A creates a match (`createMatch(token, stake, sessionA)`); B joins
   (`joinMatch(matchId, sessionB)`).
3. The server's `watchMatchJoined` opens the room; both play session-key-signed
   moves; the board updates in real time.
4. On end: happy path → both sign the result, server submits `settleSigned`,
   winner is paid the pot minus rake, Treasury gets the rake, receipt deeplink
   shows. Dispute/abandon → `proposeResult` + challenge window + keeper
   `finalize`/`voidExpired`.
5. Open `/stats` — counts, volume, and revenue reflect the settled match.

---

## 4b. Durable hosting (so the URL survives)

A Codespace tunnel dies on idle. For a persistent URL, host the two services:

### Front — Vercel

Connect the GitHub repo in Vercel and set:

- **Root Directory**: `packages/app`
- **Include source files outside of the Root Directory**: **ON** (the app imports
  the sibling `protocol`/`engine` packages by relative path; `next.config.mjs`
  sets `outputFileTracingRoot` to the repo root so they're bundled).
- **Environment variables**: everything from `packages/app/.env.local` —
  `STATS_RPC_URL`, `ESCROW_ADDRESS`, `ESCROW_FROM_BLOCK`, `CELO_TESTNET`, and all
  `NEXT_PUBLIC_*` (chain id, RPC, escrow, verifier, **server URL**, stake token).

Vercel gives a stable `https://<project>.vercel.app` — open that in MiniPay.

### Game server — any container host (Railway / Render / Fly.io)

```bash
docker build -f packages/game-server/Dockerfile -t awale-server .
docker run -p 8080:8080 --env-file packages/game-server/.env awale-server
```

The image boots read-only without a signer; set `SERVER_SIGNER_KEY` (funded) to
let it submit settlements. Point the app's `NEXT_PUBLIC_SERVER_URL` at the host's
public URL. Verified: the container boots against live Celo Sepolia and serves
`GET /` health + the Socket.IO transport.

## 5. Pre-listing checklist (MiniPay requirements)

- [x] Celoscan/Blockscout-verified contracts, with **sample tx hashes** — a full
      v4 match (create → join → keeper finalizeStart → settleSigned) is recorded
      in [sample-transactions.md](sample-transactions.md). External audit still
      gates **mainnet** (not testnet listing).
- [x] Zero-click connect; no message signing; no raw `0x…` as a primary label
      (EIP-6963 + MiniPay fast-path; session-key move signing; display names).
- [x] Stablecoin-only copy; feeCurrency on every tx; legacy (non-EIP-1559) txs
      (Celo has no `baseFeePerGas`, so viem emits type-0 legacy txs by default —
      verified on the sample match above). **feeCurrency is per-token** — resolved
      from the tx's stablecoin via `tokens.ts` (USDm pays in USDm; USDC/USDT via
      their adapters), including the Weekly-race on-chain prize claim. **Mainnet:
      set `NEXT_PUBLIC_FEE_CURRENCY` (app) and `FEE_CURRENCY` (server) to the
      deployed token's feeCurrency** so every tx — and the operator's own —
      pays gas in stablecoin, not native CELO. On testnet the stake token is a
      Mock USDm that is NOT in Celo Sepolia's feeCurrency whitelist, so testnet
      txs necessarily fall back to native CELO; this clears on mainnet's real
      whitelisted tokens.
- [x] 360×640, SVG/WebP, bundle ≤ 2 MB (First Load JS ≈ 87–213 kB), **PageSpeed 93**
      (mobile, pagespeed.web.dev) — A11y 100 / best-practices 96 / SEO 100. Cleared
      the 90+ gate via WebP hero assets + LCP preload + socket.io lazy-load; see
      [pagespeed.md](pagespeed.md).
- [~] Public `/stats` page — DAU / volume / revenue live; **MAU / retention /
      failed-tx still to add** (optional for listing, nice for the readiness call).
- [x] In-app support, ToS/Privacy — `/tos` + `/privacy` pages, footer links, and
      support email live; 24h critical-fix SLA stated in the ToS.
- [ ] Submit the intake form at `minipay.to/mini-apps`; complete the readiness
      form after the first call. **(Needs: the sample tx links above + a PageSpeed
      score + monthly-transacting-users estimate.)**

Legend: `[x]` done · `[~]` mostly done, one measurable item left · `[ ]` open.

---

## 6. Known gaps before mainnet

These are tracked in code/audits and must be closed before real-money mainnet:

- **External audit** of all contracts (especially the `HarvestVault` lending
  integration) — the in-repo `audits/` are self-reviews, not a substitute.
- **VRF** for the first-mover instead of the `prevrandao` placeholder
  (`MatchEscrow` L-01).
- **Timelock + multisig** ownership (L-02 across contracts). Run
  `script/Govern.s.sol` (env: `MULTISIG`, `TIMELOCK_DELAY`) to deploy a
  TimelockController and transfer MatchEscrow + Treasury ownership to it; admin
  changes then flow through schedule → delay → execute by the multisig.
- **Server persistence** (Redis live state, Postgres history) and an **ODIS**
  signer for phone-first display names (backend keys only).
- **Self** proof-of-personhood gating for ranked/cash (anti-sybil).
