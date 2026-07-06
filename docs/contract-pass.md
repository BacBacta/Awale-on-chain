# Pre-mainnet contract pass

**Date:** 2026-07-06 · **Status:** implemented + tested; escrow v2 deployed on
Celo Sepolia (see below), HarvestVault fee shipped but NOT enabled.

One grouped pass, one future audit, one redeploy — instead of piecemeal
contract churn. Contents and rationale:

## 1. MatchEscrow v2

| Change | Why |
|---|---|
| `MAX_RAKE_BPS` 1000 → **2000**; deployed rake **1100 (11%)** | Product decision: 11% rake, 55% platform / 45% weekly-league pot. The v1 ceiling (10%) made 11% impossible even for the owner. |
| `voidExpired` **permissionless** (was player-only) | An expired match is stuck money, and the players may be exactly the ones who can no longer act (lost device/keys). Matches #19/20/21/33/34 sat frozen forever because the operator wasn't a player. Funds still only ever return to the players. |
| **Open matches expire** (`openTtl`, default = matchTtl): `createMatch` arms `activeDeadline`; expired Open → anyone refunds the creator via `voidExpired` | A v1 Open table nobody joined locked the creator's stake for life if they lost their wallet — no TTL, creator-only cancel. |

Unchanged: settlement paths, session keys, challenge, snapshot semantics
(rake at create, window at join), stake floor, token allowlist.

## 2. HarvestVault — protocol yield fee (implemented, **disabled**)

`setYieldFee(treasury, bps)` (cap 30%): at `finalize`, the fee is taken from
the **yield only** — the principal below that line is untouched, so the
no-loss promise cannot be affected. Default **0 bps** → behaviour identical
to v1 (100% of yield to players).

**Not enabled and not deployed**: the Season remains gated on the external
audit (custodial pooled principal = honeypot risk). The fee ships in the same
audit. Fuzz test pins: fee is always a slice of yield, principal always exact.

## 3. Weekly-league economics (server-side, already live)

Rake split **55% platform / 45% pot**; pot split **95% dividend pro-rata to
points across ALL ranked players + 5% podium bonus (2.5/1.5/1)**; prizes are
claimed ("Collect now" in Compete), not pushed.

Note: on-chain rake was 8% until escrow v2; the league math reads the actual
`rakeBps` snapshotted per match, so the transition needs no server change.

## Deployment record (Celo Sepolia)

- MatchEscrow v2: see `NEXT_PUBLIC_ESCROW_ADDRESS` (app env) / `ESCROW_ADDRESS`
  (server env) — deployed by `script/DeployEscrowV2.s.sol`, aUSD allowed,
  rake 1100 bps, window 600s, TTLs 86400s.
- v1 escrow `0x813eF5EAAF5E90D791F6A8FEdeE2F1990CCB4F54` still holds history
  (leaderboard/stats reset with the new address — expected on testnet).
  Any stake still stuck on v1 (e.g. matches #45/#46 pre-TTL at switch time)
  is reclaimable by the operator once expired:
  `cast send 0x813e…F54 "voidExpired(uint256)" <id> --private-key $K --rpc-url $CELO_SEPOLIA_RPC`
  (operator is a player in both; on v1 voidExpired is player-gated.)

## Still open for the audit itself

- HarvestVault external audit (gates enabling the Season + yield fee).
- Then: `setYieldFee(treasury, 3000)` (30% of yield — the hard cap
  `MAX_YIELD_FEE_BPS`, so the fee IS the maximum the contract can ever take).
  Players keep 70% of yield; principal always returns in full (no-loss).
