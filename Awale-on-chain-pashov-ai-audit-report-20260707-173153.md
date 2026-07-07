# 🔐 Security Review — Awale-on-chain (launch contracts)

---

## Scope

|                                  |                                                        |
| -------------------------------- | ------------------------------------------------------ |
| **Mode**                         | ALL (5 in-scope contracts)                             |
| **Files reviewed**               | `MatchEscrow.sol` · `WeeklyPrizes.sol` · `Treasury.sol`<br>`ReplayVerifier.sol` · `AwaleRules.sol` |
| **Method**                       | Pashov solidity-auditor — 12 parallel attacker agents → dedup → 4 judging gates |
| **Confidence threshold (1-100)** | 80                                                     |

---

## Findings

[98] **1. A losing/abandoning player steals the opponent's stake via an unprovable `proposeResult` commitment**

`MatchEscrow.proposeResult` / `challenge` / `finalize` · Confidence: 98

**Description**
`proposeResult` records an arbitrary caller-chosen `transcriptCommitment` (only `!= 0` is checked, `MatchEscrow.sol:300`) and never binds it to a *terminal, replayable* game; because the sole void defense in `challenge` requires the challenger to submit a transcript that hashes to *that* commitment (`:356`), a participant on any non-terminal match proposes themselves the winner with `commitment = keccak256("junk")`, which makes the terminal-challenge branch unusable (no terminal transcript exists — the opponent can't forge the missing moves) and the non-terminal void branch unusable (no keccak preimage), `voidExpired` rejects `Proposed` status (`:390`), and `finalize` then pays the false winner — direct theft of the opponent's stake, exploitable with zero gameplay by any creator or joiner. The same mechanism runs in reverse: a *losing* player commits to a real non-terminal prefix and challenges it themselves (the void branch admits the proposer, since no proposer identity is stored) to convert a legitimate loss into a mutual refund. The server keeper backstop does not help — it only challenges when `state.over == true` (`main.ts:1223`), which is exactly the state that never occurs here.

**Attack trace (theft direction)**
```
A createMatch(USDC, 100e6) → B joinMatch (stakes 100e6) → status Active, pot 200e6
A finalizeStart(id)                        // permissionless; sets startTurn
A proposeResult(id, winner=A, keccak256("junk"))   // all requires pass; status Proposed
B challenge(id, realPartialTranscript):
   verify() → over==false → require(transcriptHash == keccak256("junk")) → REVERT
   (terminal branch unreachable: game never ended, B cannot forge A's signed moves)
B has no other path: voidExpired rejects Proposed; settleSigned needs A's sig
… challengeWindow elapses …
anyone finalize(id) → _payout(A) → A gets 178e6, B loses 100e6.  Net: +78e6 per match.
```

**Fix** — do not let `finalize` pay an *asserted* winner; require the winner to be *proven* on-chain, and make the void remedy independent of a proposer-chosen hash. `proposeResult` must carry the transcript, verify it, and bind the outcome to the verifier's result:

```diff
-    function proposeResult(uint256 matchId, uint8 winner, bytes32 commitment) external {
+    function proposeResult(uint256 matchId, ReplayVerifier.Transcript calldata t) external {
         Match storage m = matches[matchId];
         require(m.status == Status.Active, "MatchEscrow: not active");
         require(block.timestamp <= m.activeDeadline, "MatchEscrow: match expired");
         require(msg.sender == m.player0 || msg.sender == m.player1, "MatchEscrow: not a player");
-        require(winner <= DRAW, "MatchEscrow: bad winner");
-        require(commitment != bytes32(0), "MatchEscrow: zero commitment");
         require(m.startTurn != START_UNSET, "MatchEscrow: start not finalized");
+        // the claim must be PROVEN, not asserted: replay the signed transcript on-chain
+        require(t.matchId == matchId && t.session0 == m.session0
+             && t.session1 == m.session1 && t.startTurn == m.startTurn, "MatchEscrow: bad transcript");
+        AwaleRules.GameState memory state = verifier.verify(t);
+        // a non-terminal game has NO winner — the only honest outcome is a void/refund;
+        // a terminal game pays exactly the verifier's canonical winner.
+        require(state.over, "MatchEscrow: game not over — use voidExpired to refund");
 
-        m.proposedWinner = winner;
-        m.transcriptCommitment = commitment;
-        m.status = Status.Proposed;
-        m.challengeDeadline = uint64(block.timestamp) + m.challengeWindow;
-        emit ResultProposed(matchId, winner, m.challengeDeadline);
+        m.proposedWinner = state.winner;
+        m.status = Status.Proposed;
+        m.challengeDeadline = uint64(block.timestamp) + m.challengeWindow;
+        emit ResultProposed(matchId, state.winner, m.challengeDeadline);
     }
```
With the winner proven at propose time, `challenge`'s non-terminal void branch (and the proposer-chosen `transcriptCommitment` field) can be removed entirely; the terminal branch stays as the permissionless keeper backstop. Abandonment now resolves through `voidExpired` (refund after TTL) — the correct outcome, since a non-terminal Awalé game has no winner. Re-run the full contract test suite after this restructuring.

---

[72] **2. A token-level blacklist on one participant permanently locks the counterparty's stake**

`MatchEscrow._payout` (DRAW branch) / `_void` · Confidence: 72

**Description**
The DRAW branch of `_payout` and all of `_void` (`voidExpired` → refund, premature-proposal void) perform *two* `safeTransfer`s — to `player0` **and** `player1` — inside one atomic `nonReentrant` call, and the allowlist concretely includes USDC/USDT (blacklist/pausable tokens); if either address is frozen by the token issuer, the second transfer reverts, reverting the whole settlement, and there is no single-sided or pull-payment fallback, so the honest counterparty's stake is trapped with no extraction path. Converged independently by two agents (boundary, flow-gap); griefing/lock rather than theft, and it depends on the external precondition of a blacklist event (which the methodology treats as plausible for arbitrary-token escrows), hence below threshold. Mitigation: settle via a pull-payment `credit[player] += amount` + `withdraw()` so one frozen recipient cannot brick the other's refund.

---

Findings List

| # | Confidence | Title |
|---|---|---|
| 1 | [98] | Losing/abandoning player steals opponent stake via unprovable `proposeResult` commitment |
| 2 | [72] | Token blacklist on one participant permanently locks counterparty's stake |

---

## Leads

_Vulnerability trails with concrete code smells where the full exploit path could not be completed in one pass, or that are admin-gated/robustness issues. Not false positives — high-signal for manual review. Not scored._

- **Cross-scale `minStake` floor** — `MatchEscrow._create` / `setMinStake` — Code smells: a single raw-unit `minStake` scalar is compared against `stake` across allowlisted tokens of differing decimals (USDC 6-dec, USDm 18-dec). No single value is a consistent economic floor: calibrated to USDC ($1 = 1e6) it lets USDm dust ($0.000000000001) pass; calibrated to USDm it bricks USDC staking. Admin-gated economics (no user theft), but the anti-dust invariant is unattainable multi-token. Fix: per-token floor mapping or normalize by `IERC20Metadata(token).decimals()`.
- **Rake rounds to zero at dust stakes** — `MatchEscrow._payout` — Code smells: `rake = pot * rakeBps / BPS` floors to 0 for `pot ≤ 8` raw units; with the live `minStake == 0` default nothing prevents it, so the "rake on every non-draw" invariant degenerates. Bounded to dust + attacker's own gas. Same root cause as the cross-scale floor. Fix: `require(rake > 0)` on non-draw payouts, or a real floor.
- **Fee-on-transfer unmeasured funding** — `MatchEscrow._create` / `_join` — Code smells: escrow credits exactly `stake` on `safeTransferFrom` without measuring the `balanceOf` delta, whereas the sibling `WeeklyPrizes.publishRound` deliberately measures `received`. Mitigated solely by the allowlist (no FoT token today); a dormant fee switch (USDT-style) turning on after allow-listing would under-fund the pool while `_payout` still disburses a full `2*stake`, silently borrowing from other matches' escrow. Defense-in-depth gap + inconsistency with WeeklyPrizes.
- **Unbounded `reclaimAfter` defeats WeeklyPrizes trust-minimization** — `WeeklyPrizes.publishRound` / `sweep` — Code smells: `publishRound` does not require `reclaimAfter > block.timestamp`, so the operator can publish a sealed pot with `reclaimAfter = 0` and `sweep` the whole amount before any winner claims (`sweep` only checks `block.timestamp > reclaimAfter`, then sets `claimed = funded`). Admin action against documented intent (no unprivileged amplifier), so not scored — but it nullifies the contract's stated "winners can always collect even if the operator turns hostile" guarantee. Fix: `require(reclaimAfter >= block.timestamp + MIN_RECLAIM_DELAY)`.
- **`isClaimable` vs `claim` / `sweep` view-state asymmetry** — `WeeklyPrizes` — Code smells: `sweep` sets `r.claimed = r.funded` but never touches the per-winner `claimed[round][account]` map, so after a sweep `isClaimable` still returns `true` for an un-claimed winner while their `claim` reverts on `funded + amount <= funded`. UI/integration foot-gun (wasted gas), no fund loss.
- **On-chain / off-chain trailing-ply parity** — `ReplayVerifier.verify` vs engine `adjudicate` — Code smells: on `state.over`, `verify` does `continue` (a trailing ply then reverts in `applyMove`), while the off-chain `adjudicate` does `return` (accepts and discards trailing plies). Proven non-exploitable this pass (terminal `challenge` ignores the committed transcript; the void branch needs `verify` to *return* not-over, but a trailing-move transcript *reverts*), so it's a robustness divergence only. **Note:** the stronger repetition-rule divergence lead (ReplayVerifier threefold `REPETITION_LIMIT=3` vs `AwaleRules` 40-ply) was **checked and closed** — two agents confirmed `packages/engine/src/awale.ts` mirrors ReplayVerifier exactly (`REPETITION_LIMIT=3`, `NO_CAPTURE_LIMIT=40`, identical `positionKey` semantics).
- **Ply equivocation via under-bound move signatures** — `ReplayVerifier.verify` — Code smells: `moveDigest` binds a signature to `(matchId, ply, house)` only — not to prior board state — so a self-equivocating player could produce two valid signatures for the same ply with different houses, yielding two canonical-looking terminal transcripts with different winners; the permissionless terminal `challenge` pays whichever is submitted first. Requires the player to self-equivocate and a client that re-signs a ply — severity hinges on client behavior.
- **`finalizeStart` re-roll grief** — `MatchEscrow.finalizeStart` — Code smells: first mover derives from `blockhash(revealBlock)`; the outcome is public once `revealBlock` is mined, and if `finalizeStart` (permissionless) is stalled 256 blocks the reveal ages out and re-rolls to a fresh block. Liveness/censorship-dependent bias, no fund-loss proof.
- **`settleSigned` vs `voidExpired` post-TTL race** — `MatchEscrow` — Code smells: after `activeDeadline` both are callable on an Active match with opposite outcomes; the loser can front-run a still-valid `settleSigned` with `voidExpired` to convert an agreed loss into a mutual refund. Loss-of-winnings griefing, self-mitigated (either party could have submitted `settleSigned` during the full TTL).

---

## Auditor's note

The headline critical (Finding 1) was found independently by **8 of 12 attacker agents** and is a genuine **launch blocker** — it defeats the H-03 keeper backstop and was missed by prior internal review rounds. Arithmetic (seed conservation, rake/pot conservation, per-round solvency, uint bounds, Merkle leaf encoding) and the terminal-challenge branch were confirmed sound. **Do not deploy to mainnet with real money until Finding 1 is fixed and the fix is re-audited.**

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. Team security reviews, bug bounty programs, and on-chain monitoring are strongly recommended. For a consultation regarding your projects' security, visit [https://www.pashov.com](https://www.pashov.com)
