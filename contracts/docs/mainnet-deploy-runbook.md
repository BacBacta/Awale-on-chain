# Mainnet deploy runbook — Awalé v7 (Celo mainnet, chainid 42220)

**Status:** proceeding to mainnet at operator's own risk — the forfeit clock +
sig-binding surface passed 4 AI re-audits but **no human security review**
(explicitly acknowledged). The Finding-1 stake-theft fix + sig-binding are
unanimously confirmed sound; the new/risky surface is the forfeit clock.

Canonical deploy script: **`script/Deploy.s.sol`** (deploys a FRESH ReplayVerifier
= the sig-binding/ackDigest v7, a fresh Treasury, and MatchEscrow, and
auto-allowlists the real Celo mainnet stablecoins). Do NOT use the old
DeployEscrowV5/V6 scripts — they reuse the pre-v7 verifier.

---

## 0. Decisions to LOCK before deploying (wrong params = loss)

| Param | Value to set | Notes |
|---|---|---|
| `OWNER` | **A multisig/timelock address** (strongly recommended) or the deployer EOA | Owner controls `setRake`, `setTreasury`, `setTokenAllowed`, TTLs. A single-key EOA is the audited **L-02** risk. A Safe on Celo mainnet is the right answer; there is no escrow pause, so owner-key compromise is serious. |
| `RAKE_BPS` | **`1100`** (11%) | Deploy.s.sol default is **250 (2.5%)** — you MUST override to match production, or you ship at 2.5%. Hard cap 2000. |
| `CHALLENGE_WINDOW` | default `600` (10 min) is fine | Reused as the forfeit window; longer = more time for the accused/keeper to rebut a stale forfeit (good). Min 300s. |
| `MATCH_TTL` | default `86400` (1 day) is fine | Active-match expiry; openTtl matches. |
| Tokens | auto (USDM `0x765D…282a`, USDC `0xceBA…118C`, USDT `0x4806…3D5e`) | Deploy.s.sol hardcodes these on chainid 42220 and refuses mocks. **Double-check these are the tokens you intend.** |
| Treasury | deployed fresh, owned by `OWNER` | Rake destination. |

**WeeklyPrizes** is a separate, optional deploy (`DeployWeeklyPrizes.s.sol`,
custodial fallback intact) — not on the money-escrow critical path.

---

## 1. Fund the deployer

The deployer key needs real **CELO for gas** (verifier + treasury + escrow +
allowlist txs; a few CELO is plenty). Never paste a funded mainnet private key
into a shared shell — use a hardware wallet / `--account` keystore or a dedicated
deployer key you control.

---

## 2. REHEARSE on Celo Sepolia first (do not skip)

Prove the full flow end-to-end on testnet with the SAME script before mainnet:

```bash
cd contracts
# with env-supplied testnet token addresses, or DEPLOY_MOCK_TOKENS=true
OWNER=<testnet-owner> RAKE_BPS=1100 \
forge script script/Deploy.s.sol --rpc-url celo_sepolia --broadcast --verify
```
Then point a staging app/server at the testnet addresses and play a full cash
game incl. **an abandonment** (verify the forfeit: client auto-ack → server
relays → winner claims → keeper finalizes/rebuts).

---

## 3. Mainnet deploy

```bash
cd contracts
OWNER=<mainnet-multisig-or-EOA> RAKE_BPS=1100 \
forge script script/Deploy.s.sol \
  --rpc-url celo --broadcast --verify \
  --legacy --with-gas-price $(cast gas-price --rpc-url celo)
# PRIVATE_KEY in contracts/.env (0x+64hex) OR pass --account <keystore>
```
Record the logged addresses: **ReplayVerifier**, **Treasury**, **MatchEscrow**.

---

## 4. Post-deploy on-chain sanity (before any real stake)

```bash
E=<escrow>; V=<verifier>
cast call $E "owner()(address)"            --rpc-url celo   # == OWNER
cast call $E "rakeBps()(uint16)"           --rpc-url celo   # == 1100
cast call $E "verifier()(address)"         --rpc-url celo   # == V (the NEW one)
cast call $E "treasury()(address)"         --rpc-url celo
cast call $E "allowedToken(address)(bool)" 0x765DE816845861e75A25fCA122bb6898B8B1282a --rpc-url celo  # true
```
Confirm the verifier is the freshly-deployed one (v7), not a legacy address.

---

## 5. Env migration (CRITICAL — signatures are domain-bound to these addresses)

Move signatures + result/ack digests bind `verifyingContract = verifier/escrow
address` in their EIP-712 domain. If the app/server point at the OLD addresses,
every signature fails on-chain. Update and redeploy:

- **App** (`packages/app`): `NEXT_PUBLIC_ESCROW_ADDRESS`, `NEXT_PUBLIC_VERIFIER_ADDRESS`,
  `NEXT_PUBLIC_CHAIN_ID=42220`, mainnet RPC.
- **Server** (`packages/game-server`): `ESCROW`, `VERIFIER`, chain id 42220, mainnet RPC,
  the keeper's funded settlement key, `feeCurrency` if used.
- Verify parity once against the deployed chain if you regenerate vectors.

---

## 6. Smoke test with a tiny real stake

Create + join a match at the **minimum** stake, play to a natural finish, confirm
`settleSigned` pays out and the treasury receives the rake. Then test one
**abandonment** end-to-end (forfeit → claim → finalize). Only then open to users.

---

## 7. On the record — accepted at launch

- **No human security review** of the forfeit clock (4 AI re-audits only).
- **L-02**: owner key controls economics/allowlist; mitigate with a multisig/timelock.
- **Deferred**: client-side rebuttal watcher (defends only vs a malicious operator).
- Residual forfeit limits: honest rebutter (accused's client OR keeper) must be
  online for one window; offline-before-ack → refund.
