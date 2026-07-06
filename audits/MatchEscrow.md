# Security Review — `MatchEscrow`

| | |
|---|---|
| **Contract** | `contracts/src/MatchEscrow.sol` |
| **Type** | Escrow / settlement (holds user funds) |
| **Reviewer** | Author self-review (Pashov-style) — *not* an external audit |
| **Review date** | 2026-06-19 (rev. 2 — first-mover randomness redesign) |
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
| H-02 | Zero/partial-transcript challenge voids any proposed match | High | **Resolved** |
| H-03 | Player-only `challenge` gate (v4) disabled the keeper anti-theft backstop | High | **Resolved (v5)** |
| M-01 | Arbitrary / fee-on-transfer staking token breaks accounting | Medium | **Resolved** |
| M-02 | Owner rake change retroactively affects in-flight matches | Medium | **Resolved** |
| M-03 | Stakes can be locked forever by a silent opponent | Medium | **Resolved** |
| M-04 | `proposeResult` callable after `activeDeadline` — locks out `voidExpired` | Medium | **Resolved** |
| L-01 | First-mover randomness is joiner-grindable via `block.prevrandao` | Low | **Resolved** |
| L-02 | Privileged owner is a trust assumption | Low | Acknowledged |
| L-03 | Reveal-block proposer retains limited influence over the coin flip | Low | Acknowledged |
| L-04 | `challenge` has no caller restriction — third-party griefing | Low | **Resolved** |
| I-01 | `block.timestamp` used for window comparisons | Informational | By design |
| I-02 | Reveal block can age out of the 256-block `blockhash` window | Informational | By design (auto re-roll) |

---

## High

### [H-02] Zero/partial-transcript challenge voids any proposed match — **Open**

**Description.** The H-01 fix introduced a new, symmetric vulnerability: `challenge` now
accepts *any* valid transcript and voids the match when the replay is non-terminal. An
adversary (or the losing player themselves) can construct a transcript with `moves = []`
and `sigs = []` — the only inputs needed are the public on-chain fields `session0`,
`session1`, and `startTurn` from `matches[matchId]`. `ReplayVerifier.verify` runs zero
iterations of its loop and returns `AwaleRules.initialState()` with `over = false`,
which `MatchEscrow.challenge` interprets as "game still live" and calls `_void`, refunding
both players. A participant who already has signed move messages can equally submit a valid
prefix of the real game (e.g. moves 0–5 of a 40-move game) for the same effect, since
`verify` has no completeness check.

**Impact:** High — a losing player can escape any rightful loss at gas cost only. Spotted
independently by all 12 audit agents (math-precision, access-control, economic-security,
execution-trace, invariant, periphery, first-principles, asymmetry, boundary, numerical-gap,
trust-gap, flow-gap).

**Resolution options:**

*Option A (minimal — closes zero-move attack):*
```diff
// ReplayVerifier.sol, after the MAX_PLIES check
  require(t.moves.length <= MAX_PLIES, "ReplayVerifier: too many plies");
+ require(t.moves.length > 0, "ReplayVerifier: empty transcript");
```
Residual risk: a participant can still submit a valid game-prefix (partial transcript) via
the same `else` branch; this requires the attacker to hold move signatures from normal play.

*Option B (full — closes both empty and partial attacks):*
Record a transcript commitment in `proposeResult` using the already-defined
`ReplayVerifier.transcriptHash()` (currently dead code), and require the `challenge`
transcript to match it before accepting a non-terminal replay as void-triggering. This is
the structural fix; see `audits/pashov-ai-report` for the diff.

**Note:** `ReplayVerifier.transcriptHash()` (line 101) carries the comment "Stored by
MatchEscrow at optimistic settlement" but is never called by `MatchEscrow` — activating
it is part of Option B.

---

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

### [M-04] `proposeResult` callable after `activeDeadline` — locks out `voidExpired` — **Open**

**Description.** `proposeResult` (line 226) checks `m.status == Status.Active` but not
`block.timestamp <= m.activeDeadline`. After the match TTL expires, the expected exit is
`voidExpired` (both players refunded, funds never locked). A malicious player can race
`proposeResult` immediately after expiry, transitioning the match to `Proposed`. Since
`voidExpired` requires `Status.Active`, the honest player's safe-exit path is permanently
closed. If the honest player is offline for the entire `challengeWindow` that follows, the
attacker calls `finalize` and claims the full prize.

**Impact:** Medium — requires the honest player to be offline for one full challenge window
after match expiry; in practice, the online player can still call `challenge` (even with an
empty transcript from H-02, getting a void refund), but the `voidExpired` safety guarantee
documented in the NatDoc is violated.

**Resolution:**
```diff
// MatchEscrow.sol, proposeResult
  require(m.status == Status.Active, "MatchEscrow: not active");
+ require(block.timestamp <= m.activeDeadline, "MatchEscrow: match expired");
```

---

### [M-03] Stakes can be locked forever by a silent opponent — **Resolved**

**Description.** An `Active` match with no `settleSigned`/`proposeResult` had no exit:
if both clients disappeared (or one griefed by never signing and never proposing),
the staked funds were locked permanently.

**Resolution.** `joinMatch` stamps `activeDeadline = now + matchTtl`; after it,
either player may call `voidExpired` to refund both stakes. Funds can no longer be
trapped. (`test_voidExpired_refundsBothAfterTtl`.)

---

## Low

### [L-01] First-mover randomness is joiner-grindable via `block.prevrandao` — **Resolved**

**Description.** `joinMatch` originally derived `startTurn` from
`keccak256(block.prevrandao, matchId, player0, msg.sender)` — every input is known
to the joiner *before* they submit the transaction (the creator's address and
`prevrandao` are both already on-chain). A joiner controlling multiple funded
wallets could simulate the result for each candidate address off-chain and submit
from whichever one wins the coin flip, biasing who moves first to their advantage
at zero cost.

**Resolution.** The flip is now deferred to a *future* block chosen at join time
(`revealBlock = block.number + START_REVEAL_DELAY`). `joinMatch` no longer computes
`startTurn` — it only schedules the reveal. The permissionless `finalizeStart`
fixes `startTurn = keccak256(blockhash(revealBlock), matchId) & 1` once that block
is mined. Because `blockhash(revealBlock)` does not exist at join time, the joiner
has nothing to grind: every candidate address would face the same unknown future
hash. `proposeResult` now requires `startTurn != START_UNSET`, so a game cannot be
settled before its flip is fixed. Covered by `test_finalizeStart_fixesFirstMover`,
`test_finalizeStart_revertsBeforeRevealBlock`, `test_finalizeStart_revertsOnceFixed`,
`test_proposeResult_revertsBeforeStartFinalized`.

### [L-04] `challenge` has no caller restriction — third-party griefing — **Open**

`challenge` (line 248) contains no `msg.sender` guard. The NatDoc says "the opponent
overturns a false claim" but the code allows any address. Combined with H-02, any address
can void any `Proposed` match at gas cost only. Even after H-02 is fixed, a participant
who obtained signed move messages through normal play can trigger the partial-transcript
path against any of their own matches. Restricting callers to match participants reduces
the attack surface to colluding or self-interested actors.

**Resolution (v4):**
```diff
  function challenge(uint256 matchId, ReplayVerifier.Transcript calldata t) external nonReentrant {
      Match storage m = matches[matchId];
+     require(msg.sender == m.player0 || msg.sender == m.player1, "MatchEscrow: not a player");
```

**Superseded by H-03 (v5).** The v4 gate above was too broad: it blocked the
*terminal* branch too, silently disabling the keeper's anti-theft backstop. See
H-03 — v5 keeps the participant-only gate **only on the void branch** (where the
grief actually lives) and makes the terminal branch permissionless.

---

### [H-03] Player-only `challenge` gate (v4) disabled the keeper's anti-theft backstop — **Resolved (v5)**

**Description.** The optimistic path (`proposeResult` → window → `finalize`) is
safe only because a false proposal can be refuted by `challenge` before the
window closes. The intended safety net when the honest winner is **offline for
the whole window** (common on mobile — a player closes the app right after
winning) is the **server keeper**: it holds the doubly-signed transcript and
auto-challenges any proposal that disagrees with the real ending ([main.ts]
`ResultProposed` watcher).

The v4 fix for L-04 added `require(msg.sender == player0 || player1)` at the top
of `challenge`. **The keeper is not a match player**, so every backstop challenge
reverted `"not a player"` — the net was dead code. Worse, `keeperActions`
finalizes any expired proposal unconditionally, so the keeper itself pays out the
lie. Net: a losing player calls `proposeResult(self)`, stays quiet for the
window, and `finalize` hands them the whole pot.

Never triggered on testnet only because the operator happened to be a player in
every manual test. With independent players on mainnet it is a direct theft path.

**Impact:** High — theft of the opponent's stake whenever the honest winner is
offline for the challenge window.

**Resolution (v5).** Split the gate by branch: the terminal branch is
permissionless (a doubly-signed terminal transcript can only *enforce the true
result*, so anyone — the keeper — may submit it); the non-terminal **void** branch
keeps the participant-only gate (that is the real L-04 grief — an outsider forcing
a refund). Defence-in-depth server-side: the keeper now **refuses to `finalize`**
a proposal whose on-chain `proposedWinner` contradicts a terminal result known to
the hub. Covered by `test_challenge_nonPlayerCanEnforceTerminalResult` (backstop
works from a stranger) and `test_challenge_nonPlayerCannotVoid` (grief still
blocked); the challenge invariant suite drives the terminal path from a non-player
keeper address.

---

### [L-02] Privileged owner is a trust assumption — *acknowledged*

The owner can set the treasury, the rake (≤ `MAX_RAKE_BPS` = 10%, hard-capped), the
TTL, and the token allowlist. None of these can seize an existing match's funds
(rake is snapshotted and capped; payouts always go to players/treasury), but the
role is trusted. **Mitigation (architecture §13):** deploy ownership behind a
timelock + multisig before mainnet.

### [L-03] Reveal-block proposer retains limited influence over the coin flip — *acknowledged*

`finalizeStart` fixes `startTurn` from `blockhash(revealBlock)`, i.e. the block
immediately after `joinMatch` (`START_REVEAL_DELAY = 1`). Unlike the joiner (who
faces a wholly unknown future hash), the validator who proposes `revealBlock`
itself has some latitude over that block's contents (transaction ordering/
inclusion) and so, in principle, limited influence over its hash. This is a
strictly smaller attack surface than L-01: it requires being the block proposer at
exactly the right height (not any joiner with a few wallets), and the prize is one
bit of first-move advantage in a deterministic, low-stakes game — judged
disproportionate to defend against with full VRF (architecture §6). Increasing
`START_REVEAL_DELAY` would not help, since whichever block is ultimately read still
has a single proposer with the same latitude.

Note that the *finalizer* gains nothing from this: `blockhash(revealBlock)` is
fixed the moment that block is mined, so whoever calls `finalizeStart` (and
whenever they call it within the 256-block window) reads the same value and cannot
bias the flip by their choice of timing. The only timing-adjacent escalation —
withholding `finalizeStart` for 256 blocks to force the I-02 re-roll onto a block
the attacker's validator then proposes — requires censoring *every* permissionless
caller (both players and the keeper) for ~21 min and is strictly dominated by the
single-proposer surface already described here.

---

## Informational

### [I-01] `block.timestamp` used for window comparisons — *by design*

The challenge window (~10 min) and match TTL (~1 day) compare against
`block.timestamp`. Validator timestamp drift (seconds) is negligible relative to
these durations. Flagged by Slither; accepted.

### [I-02] Reveal block can age out of the 256-block `blockhash` window — *by design*

`blockhash` only returns non-zero for the most recent 256 blocks. If no one calls
`finalizeStart` within that window (e.g. the off-chain keeper is down), the first
call sees `blockhash(revealBlock) == 0` and **re-rolls** to a fresh future block
instead of fixing a fake `startTurn` of `0`. The match simply waits one more reveal
cycle; no funds are at risk (`proposeResult`/`settleSigned` still work once a real
session-signed transcript exists, and `voidExpired` remains available throughout).
This only affects liveness of the *fairness* flip, never custody of stakes.

---

## Security properties confirmed

- **Reentrancy** — all fund-moving externals are `nonReentrant`; state is set to a
  terminal status *before* any `safeTransfer` (checks-effects-interactions). The
  allowlist also excludes hook-bearing tokens.
- **No forged settlement** — `settleSigned` requires both session-key signatures
  over the EIP-712 result; `challenge` binds the transcript's `matchId`, sessions,
  and `startTurn` to the stored match before trusting the replay.
- **`startTurn`-finalization gate is asymmetric *by design*** — `proposeResult`
  (a unilateral claim that feeds `challenge`'s `t.startTurn == m.startTurn` check)
  requires `startTurn != START_UNSET`, but `settleSigned` deliberately does **not**:
  a result both session keys signed is mutual consent, for which first-move fairness
  is moot, so the happy path is never blocked on a pending reveal or a stalled keeper.
- **Conservation** — every path (`_payout` win/draw, `_void`, `cancelMatch`) moves
  exactly the escrowed `2 × stake`; tested for balances and drained escrow.
- **Decimals** — amounts are in the token's own units; exercised with a 6-decimal mock.

## Residual risk & recommendations

1. **External audit still required** before mainnet — this is a self-review.
2. Move ownership to timelock + multisig (**L-02** — see `timelock` deployment in
   the deploy scripts; tracked separately from this report).
3. Consider a per-match `minStake`/`maxStake` and a global pause for incident response.
4. Re-review once `Treasury`/`HarvestVault` are wired in, as rake routing will then
   call into another contract.
5. **L-03** is accepted as-is: closing it fully requires Chainlink VRF, which is
   disproportionate for one bit of advantage in a deterministic, low-stakes game.
   Revisit if stakes per match grow large enough to make proposer-grinding worth a
   validator's risk of being caught/slashed.

## Conclusion

One High and three Mediums were found during this review and **all resolved with
fixes and regression tests**. A subsequent revision closed **L-01** (joiner-grindable
randomness) by deferring the first-move flip to a future block's hash instead of
data the joiner already controls; this introduced one new, strictly narrower
acknowledged Low (**L-03** — proposer-only, not joiner, influence) and one
informational liveness note (**I-02**). A review pass over the redeployed code
confirmed two design properties (the finalizer cannot bias the flip by timing;
the `startTurn`-finalization gate is intentionally asymmetric between `proposeResult`
and `settleSigned`).

A subsequent adversarial pass by a 12-agent parallelized AI review (Pashov skills,
sonnet model, 2026-06-19) surfaced two new open findings and one low:

- **H-02**: The H-01 fix introduced a symmetric vulnerability: `challenge` accepts an
  empty transcript (`moves=[], sigs=[]`), which `ReplayVerifier.verify` processes in
  zero iterations and returns `initialState()` (non-terminal), triggering `_void` and
  refunding both players — the losing player escapes any rightful loss at gas cost only.
  Confirmed by all 12 agents. The `ReplayVerifier.transcriptHash()` function (currently
  dead code from MatchEscrow's perspective) was intended to support a commitment
  mechanism that would close this attack; it should be activated as part of the fix.

- **M-04**: `proposeResult` has no guard against being called after `activeDeadline`,
  allowing a malicious player to race `voidExpired` on an expired match and revoke the
  honest opponent's guaranteed-refund path.

- **L-04**: `challenge` has no `msg.sender` restriction, enabling any address to trigger
  the H-02 void attack (not just match participants).

**All three are resolved** — fixes and regression tests (`test_challenge_revertEmptyTranscript`,
`test_challenge_revertNonPlayer`, `test_proposeResult_revertAfterExpiry`) added in the same
pass. 28 MatchEscrow tests / 93 across the contracts suite passing, no failures.

Note: the *partial-transcript* variant of H-02 (a participant submitting a valid game prefix
with real move signatures) is mitigated by the `moves.length > 0` guard but not eliminated;
the complete fix requires recording a `transcriptHash` commitment at `proposeResult` time and
activating `ReplayVerifier.transcriptHash()` (currently dead code from MatchEscrow's
perspective). This is tracked as a residual risk and must be addressed before mainnet.

An independent external audit is still mandatory before handling real funds.
