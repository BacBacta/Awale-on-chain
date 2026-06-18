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
cp .env.example .env        # fill PRIVATE_KEY, OWNER, USD*_ADDRESS, RPC, ETHERSCAN_API_KEY
forge test                  # sanity: full suite green
forge script script/Deploy.s.sol \
  --rpc-url "$CELO_SEPOLIA_RPC" \
  --broadcast \
  --verify
```

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

Fill each package's `.env` from its `.env.example` with the deployed addresses:

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

## 5. Pre-listing checklist (MiniPay requirements)

- [ ] Audited + Celoscan-verified contracts, with sample tx hashes.
- [ ] Zero-click connect; no message signing; no raw `0x…` as a primary label.
- [ ] Stablecoin-only copy; feeCurrency on every tx; legacy (non-EIP-1559) txs.
- [ ] 360×640, SVG/WebP, bundle ≤ 2 MB (current build ≈ 135 kB First Load JS),
      PageSpeed 90+.
- [ ] Public `/stats` page (DAU/MAU/retention/volume/revenue/failed-tx).
- [ ] In-app support, ToS/Privacy, 24h critical-fix SLA.
- [ ] Submit the intake form at `minipay.to/mini-apps`; complete the readiness
      form after the first call.

---

## 6. Known gaps before mainnet

These are tracked in code/audits and must be closed before real-money mainnet:

- **External audit** of all contracts (especially the `HarvestVault` lending
  integration) — the in-repo `audits/` are self-reviews, not a substitute.
- **VRF** for the first-mover instead of the `prevrandao` placeholder
  (`MatchEscrow` L-01).
- **Timelock + multisig** ownership (L-02 across contracts).
- **Server persistence** (Redis live state, Postgres history) and an **ODIS**
  signer for phone-first display names (backend keys only).
- **Self** proof-of-personhood gating for ranked/cash (anti-sybil).
