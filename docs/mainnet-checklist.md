# Pre-mainnet checklist

Hard gates that must be cleared before handling real funds on mainnet or MiniPay listing.
Ordered roughly by dependency: security first, then infrastructure, then ops.

---

## Security

### [BLOCKER] Partial-transcript challenge attack — transcript commitment mechanism

**Context:** H-02 (`MatchEscrow.challenge` accepting empty/zero-move transcripts) was
fixed by `require(t.moves.length > 0)` in `ReplayVerifier.verify`. This closes the
zero-cost attack (any address, no data needed). However, the *partial-transcript*
variant remains: a losing player who holds real move signatures from the game can submit a
valid game prefix (e.g. moves 0–5 of a 40-move game) to the `challenge` function, which
still returns `over = false` from the verifier and triggers `_void`, letting the loser
recover their stake instead of forfeiting it.

**Required fix:** Activate `ReplayVerifier.transcriptHash()` (currently dead code from
`MatchEscrow`'s perspective) as a commitment recorded at `proposeResult` time:

1. Add `bytes32 transcriptCommitment` to the `Match` struct.
2. Change `proposeResult` signature to `proposeResult(uint256 matchId, uint8 winner, bytes32 commitment)` — the proposer computes `verifier.transcriptHash(t)` off-chain and commits to it.
3. In `challenge`, before calling `_void` on a non-terminal replay, require `verifier.transcriptHash(t) == m.transcriptCommitment` — if the challenger submits a *different* transcript (e.g. a shorter prefix), the hashes won't match and the void is rejected.

**Off-chain impact:** the game client and game server must pass the transcript hash when
calling `proposeResult`. This is a coordinated on-chain + off-chain change.

**Reference:** `audits/MatchEscrow.md` § H-02 (Option B), `audits/ReplayVerifier.md`.

---

### [BLOCKER] Independent external audit

The internal reviews in `audits/` are self-conducted and do not substitute for an
independent third-party audit. Required before any real-money deployment.
See `audits/README.md` for scope.

---

### [REQUIRED] Ownership behind timelock + multisig

Owner controls treasury address, rake (capped at 10%), token allowlist, TTL, and
challenge window. The timelock + multisig deployment scripts exist (`scripts/deploy/`)
but ownership transfer must be executed and verified on-chain before mainnet.
Reference: `audits/MatchEscrow.md` § L-02.

---

### [REQUIRED] `challengeWindow` minimum bound

`setChallengeWindow` accepts any `uint64` including 0. Add a reasonable on-chain
minimum (e.g. `require(window >= MIN_CHALLENGE_WINDOW)` where `MIN_CHALLENGE_WINDOW`
is a constant, e.g. 5 minutes). This prevents a misconfigured or compromised owner
from collapsing the dispute period.
Reference: `audits/MatchEscrow.md` lead — `setChallengeWindow no minimum bound`.

---

### [REQUIRED] `challengeWindow` snapshotted at match creation

Unlike `rakeBps` (which is correctly snapshotted into `m.rakeBps` at `createMatch`),
`challengeWindow` is read live at `proposeResult` time. A post-join owner change can
alter the window for in-flight matches. Snapshot it into the `Match` struct at
`joinMatch` (same pattern as rake).
Reference: `audits/MatchEscrow.md` lead — `challengeWindow not snapshotted`.

---

## Infrastructure

### [REQUIRED] Per-match stake floor

No minimum stake is enforced beyond `require(stake > 0)`. At dust-level stakes the
rake formula rounds to zero (integer truncation). Add a `minStake` constant or
owner-settable parameter and check it in `createMatch`.

### [REQUIRED] Global pause / circuit breaker

Add an emergency pause (OpenZeppelin `Pausable`) so the team can freeze new match
creation in case of an incident without disrupting in-flight matches.

### [REQUIRED] Treasury and HarvestVault integration re-review

Once `Treasury` and `HarvestVault` are wired into the rake routing path, `_payout`
will call into an external contract. Re-run the reentrancy and accounting review for
that path. Reference: `audits/MatchEscrow.md` § Residual risk 4.

---

## Ops

### [REQUIRED] Keeper reliability

`finalizeStart` must be called within 256 blocks of `revealBlock` or a re-roll
occurs. The off-chain keeper must have uptime guarantees and alerting before mainnet.

### [REQUIRED] VRF cost/benefit re-evaluation at higher stakes

The 1-block reveal delay gives a block-proposing validator limited first-move
advantage. Acceptable at low stakes; if per-match stakes grow significantly, evaluate
replacing `blockhash`-based randomness with Chainlink VRF.
Reference: `audits/MatchEscrow.md` § L-03.

### [REQUIRED] Bug bounty program

Launch a public bug bounty (Immunefi or similar) before or alongside mainnet
deployment, covering at minimum `MatchEscrow`, `ReplayVerifier`, and `AwaleRules`.
