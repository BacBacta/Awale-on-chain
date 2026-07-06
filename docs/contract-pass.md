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

## 1b. MatchEscrow v3 + ReplayVerifier v2 — anti-stall (deployed 2026-07-06)

Threefold-repetition (anti-stall) rule made transversal: a trailing player can
no longer drag a decided endgame out forever. Off-chain the server/engine end a
provably-cyclic position via `adjudicate`; on-chain the **new ReplayVerifier**
mirrors the same rule in `verify`, so a repetition-ended money game resolves to
the seed-leader on the *challenge* path (the old verifier lacked the rule and
would have *voided*/refunded instead). Happy path (`settleSigned`) already paid
correctly — this closes the dispute path. Economics identical to v2 (rake 1100
bps, window 600s, TTLs 86400s, aUSD allowed). Deployed by
`script/DeployEscrowV3.s.sol` (deploys the verifier + escrow together).

- **MatchEscrow v3** `0x53c7594ca2943ee43fB24a6F11C6b438b7F06EFA` (current)
- **ReplayVerifier v2** `0xF6B27BBDe627eD9f241C3017aCa33bb472064395` (current)
- Parity net: `ReplayVerifier.t.sol` verifies a real 98-ply repetition game
  (from the TS engine, `fixtures/repetition.json`) to the identical swept
  outcome on-chain; an extra ply reverts. Foundry 135 green.

## 1c. MatchEscrow v4 — audit M1 (deployed 2026-07-06)

Single change vs v3: `voidExpired` no longer accepts a **Proposed** match. A
losing player could wait out the TTL and void a legitimately proposed result
away (full refund instead of their loss). A Proposed match is never stuck —
`finalize` is permissionless with no deadline once the challenge window
closes — so removing Proposed closes the escape without creating any lockup.
The /matches UI stopped offering reclaim on Proposed rows (that button WAS
the exploit); the keeper already finalized Proposed matches correctly.
Deployed by `script/DeployEscrowV4.s.sol`, reusing the v2 ReplayVerifier.

Dispute path is now invariant-fuzzed too (`MatchEscrowChallenge.invariant.t.sol`):
terminal challenges only ever pay the canonical winner, premature claims only
ever void — under random false claims and a changing rake.

## Deployment record (Celo Sepolia)

- **MatchEscrow v4** `0x34473d4b1dD93314b13605277681b4202C55c4E8` — current
  escrow (`NEXT_PUBLIC_ESCROW_ADDRESS` / `ESCROW_ADDRESS`), deploy block
  30077576, verifier `0xF6B27BBDe627eD9f241C3017aCa33bb472064395` (reused).
- MatchEscrow v3 `0x53c7594ca2943ee43fB24a6F11C6b438b7F06EFA` — legacy
  (repetition pass; had the M1 quirk).
- MatchEscrow v2 `0x616E36848B660a58dB3cb3181D935A802847cc24` — legacy,
  old verifier `0xBE1B068842cA735DE9F8EA0daAbd371fFEA6Ef78`.
- MatchEscrow v1 `0x813eF5EAAF5E90D791F6A8FEdeE2F1990CCB4F54` — legacy.
- All legacy escrows sit in `NEXT_PUBLIC_LEGACY_ESCROW_ADDRESSES` so
  history/stats span the migrations.
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
