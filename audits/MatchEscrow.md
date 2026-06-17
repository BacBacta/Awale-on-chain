# Security Review — `MatchEscrow`

| | |
|---|---|
| **Contract** | `contracts/src/MatchEscrow.sol` |
| **Type** | Escrow / settlement (holds user funds) |
| **Reviewer** | Author self-review (Pashov-style) — *not* an external audit |
| **Review date** | 2026-06-17 |
| **Branch** | `feat/contracts-rules-engine` |
| **Dependencies** | OpenZeppelin v5.1.0 (`SafeERC20`, `ReentrancyGuard`, `Ownable`, `ECDSA`, `MessageHashUtils`), `ReplayVerifier`, `AwaleRules` |

## Scope & purpose

`MatchEscrow` locks both players' stablecoin stakes, registers their per-match
session keys, and settles by one of three paths: `settleSigned` (both signed the
result — instant), `proposeResult` + `finalize` (single-party claim behind a
challenge window), and `challenge` (full on-chain replay via `ReplayVerifier`). It
is the only contract here that custodies funds, so it carries the real risk.

## Findings summary

| ID | Title | Severity | Status |
|---|---|---|---|
| H-01 | Pot theft via premature `proposeResult` on a live game | High | **Resolved** |
| M-01 | Arbitrary / fee-on-transfer staking token breaks accounting | Medium | **Resolved** |
| M-02 | Owner rake change retroactively affects in-flight matches | Medium | **Resolved** |
| M-03 | Stakes can be locked forever by a silent opponent | Medium | **Resolved** |
| L-01 | First-mover randomness is validator/joiner-influenceable | Low | Acknowledged |
| L-02 | Privileged owner is a trust assumption | Low | Acknowledged |
| I-01 | `block.timestamp` used for window comparisons | Informational | By design |

---

## High

### [H-01] Pot theft via premature `proposeResult` on a live game — **Resolved**

**Description.** `proposeResult` lets a participant claim a winner and open a
challenge window; `challenge` could only *overturn* it by submitting a **terminal**
transcript (`require(state.over)`). A losing player could therefore call
`proposeResult(self)` while the game was **still in progress**. Their opponent, who
only holds a non-terminal signed transcript, could not satisfy `require(state.over)`
— so the challenge reverted, the window elapsed, and the liar called `finalize` to
steal the entire pot.

**Impact:** High — direct theft of the opponent's stake under realistic, easily
triggered conditions (any participant, any unfinished match).

**Resolution.** `challenge` now accepts any *valid* transcript bound to the match and
branches on whether the replay is terminal:

- **terminal** → the verifier's winner is canonical and is paid out (a true result
  always beats a false proposal);
- **non-terminal but valid** → it *proves the game was still live*, so the proposal
  was premature: the match is **voided and both stakes are refunded** (`_void`), with
  no winner and no rake.

A dishonest proposal can therefore never yield a payout — at worst it forces a
refund. Covered by `test_challenge_voidsPrematureProposal`.

---

## Medium

### [M-01] Arbitrary / fee-on-transfer staking token breaks accounting — **Resolved**

**Description.** `createMatch` accepted any ERC-20. A fee-on-transfer or rebasing
token would leave the escrow holding less than `2 × stake`, so a later full payout
could revert or drain a different match's funds; a malicious token with transfer
hooks also widens the reentrancy surface.

**Resolution.** Added an owner-managed `allowedToken` allowlist and
`require(allowedToken[token])` in `createMatch`. Only audited, non-rebasing,
non-fee-on-transfer stablecoins (USDm / USDC / USDT) are allowlisted, matching the
architecture's token policy. (`test_createMatch_revertTokenNotAllowed`.)

### [M-02] Owner rake change retroactively affects in-flight matches — **Resolved**

**Description.** `_payout` read the live `rakeBps`, so an owner could raise the rake
(up to the 10% cap) *after* players had already staked, changing the economic terms
of matches in progress.

**Resolution.** The rake is now snapshotted into `Match.rakeBps` at `createMatch` and
`_payout` uses the snapshot, so a later `setRake` cannot alter an existing match.
(`test_rakeSnapshot_unaffectedByLaterSetRake`.)

### [M-03] Stakes can be locked forever by a silent opponent — **Resolved**

**Description.** An `Active` match with no `settleSigned`/`proposeResult` had no exit:
if both clients disappeared (or one griefed by never signing and never proposing),
the staked funds were locked permanently.

**Resolution.** `joinMatch` stamps `activeDeadline = now + matchTtl`; after it,
either player may call `voidExpired` to refund both stakes. Funds can no longer be
trapped. (`test_voidExpired_refundsBothAfterTtl`.)

---

## Low

### [L-01] First-mover randomness is validator/joiner-influenceable — *acknowledged*

`joinMatch` derives `startTurn` from `block.prevrandao` and match data. A validator,
or a joiner choosing when to submit, can bias a single bit (who moves first). In a
deterministic, full-information game first-move advantage is small but non-zero.
Documented in-code as a v1 placeholder; **replace with Chainlink VRF (or
commit-reveal) before mainnet** per architecture §6.

### [L-02] Privileged owner is a trust assumption — *acknowledged*

The owner can set the treasury, the rake (≤ `MAX_RAKE_BPS` = 10%, hard-capped), the
TTL, and the token allowlist. None of these can seize an existing match's funds
(rake is snapshotted and capped; payouts always go to players/treasury), but the
role is trusted. **Mitigation (architecture §13):** deploy ownership behind a
timelock + multisig before mainnet.

---

## Informational

### [I-01] `block.timestamp` used for window comparisons — *by design*

The challenge window (~10 min) and match TTL (~1 day) compare against
`block.timestamp`. Validator timestamp drift (seconds) is negligible relative to
these durations. Flagged by Slither; accepted.

---

## Security properties confirmed

- **Reentrancy** — all fund-moving externals are `nonReentrant`; state is set to a
  terminal status *before* any `safeTransfer` (checks-effects-interactions). The
  allowlist also excludes hook-bearing tokens.
- **No forged settlement** — `settleSigned` requires both session-key signatures
  over the EIP-712 result; `challenge` binds the transcript's `matchId`, sessions,
  and `startTurn` to the stored match before trusting the replay.
- **Conservation** — every path (`_payout` win/draw, `_void`, `cancelMatch`) moves
  exactly the escrowed `2 × stake`; tested for balances and drained escrow.
- **Decimals** — amounts are in the token's own units; exercised with a 6-decimal mock.

## Residual risk & recommendations

1. **External audit still required** before mainnet — this is a self-review.
2. Replace first-mover randomness with VRF (**L-01**).
3. Move ownership to timelock + multisig (**L-02**).
4. Consider a per-match `minStake`/`maxStake` and a global pause for incident response.
5. Re-review once `Treasury`/`HarvestVault` are wired in, as rake routing will then
   call into another contract.

## Conclusion

One High and three Mediums were found during this review and **all resolved with
fixes and regression tests** (21 `MatchEscrow` tests; 50 across the suite). Two Lows
are acknowledged with clear pre-mainnet mitigations. No reentrancy or access-control
defects remain. An independent external audit is still mandatory before handling
real funds.
