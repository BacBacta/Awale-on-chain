# 🔐 Security Re-Audit — Awale-on-chain v7 (forfeit clock + sig-binding)

---

## Scope

|                                  |                                                        |
| -------------------------------- | ------------------------------------------------------ |
| **Mode**                         | Re-audit of NEW v7 attack surface (12 agents)          |
| **Files reviewed**               | `MatchEscrow.sol` · `ReplayVerifier.sol` · `AwaleRules.sol`<br>`WeeklyPrizes.sol` · `Treasury.sol` |
| **New surface**                  | forfeit clock (`proposeForfeit`/`rebutForfeit`/`finalizeForfeit`), `moveDigest` state-binding, `proposeResult` terminal proof |
| **Method**                       | Pashov 12-agent re-audit → dedup → gates                |
| **Confidence threshold (1-100)** | 80                                                     |

---

## Verdict

**The forfeit clock is fundamentally unsound and MUST NOT ship.** 10 of 12 agents found a theft in it; **7 independently proved the un-defendable variant** (own-move equivocation). **Every agent confirmed the Finding-1 fix (`proposeResult` terminal proof) and the `moveDigest` state-binding are SOUND with no bypass**, and WeeklyPrizes/Treasury clean.

---

## Findings

[95] **1. Forfeit-clock theft via forged (own-move-equivocated) prefix**

`MatchEscrow.proposeForfeit` / `rebutForfeit` / `finalizeForfeit` · Confidence: 95 · **7-agent convergence**

**Description**
A player holds their own session key, so they can sign a *legal but never-played* move for their own turn — `moveDigest` binds the pre-move position but **not which of the legal moves is chosen** — producing an internally-valid transcript that forks off the canonical line onto a branch the opponent never signed; `proposeForfeit` accepts any such non-terminal prefix ending on the opponent's turn (it only checks `verify` + `!over` + `msg.sender != accused` + `length > lastRebuttedPly`), sets `proposedWinner = attacker`, and the accused **cannot rebut** because `rebutForfeit` demands a transcript whose first `forfeitPly` moves hash to the attacker's committed *forked* prefix — which requires the accused to hold a signature on the forked position they never saw. The keeper backstop slices the *hub's real* transcript, so it either returns `null` ("genuine abandonment") or reverts on-chain with `"prefix mismatch"`; the app never wired `rebutForfeit` at all; `voidExpired` excludes `ForfeitPending` and `proposeResult` requires `Active` — so no exit exists and `finalizeForfeit` (auto-run by the keeper) pays the attacker the whole pot.

**Minimal proof**
```
Match Active, startTurn=0, Alice=player0 holds session0. (Zero real moves needed.)
Alice signs moveDigest(matchId, 0, house=2, stateHash(initialState)) with session0.
Alice: proposeForfeit(matchId, {…, moves:[2], sigs:[sig]})
  verify ✓ (1 legal signed move, !over, turn→1) → accused=player1(Bob),
  proposedWinner=0, ForfeitPending, deadline=now+5min.
Bob cannot rebut: rebutForfeit needs t2.moves[0]==2 with session0's sig → Bob lacks it.
Keeper forfeitRebuttal(hub len 0, ply 1) → null → stands down.  App has no rebut path.
After 5 min: finalizeForfeit → _payout(0) → Alice takes pot − rake. Bob loses his stake
having never had a turn.
```

**Root cause & why it can't be patched at the rebuttal layer**
The forfeit assumes the claimant-chosen prefix is the *canonical, current* game line. It isn't: the claimant authors the pivotal last move themselves (own-move equivocation). Rebuttal-side fixes ("let the accused submit any longer valid line") fail against a **frontier fork** — when the attacker forks on their own current-turn move, `forfeitPly` exceeds the real game length, so the accused has *no* real move at ply ≥ `forfeitPly`. The only sound fix binds the accusation to a position the opponent **acknowledged**.

**Fix** — the forfeit must anchor to mutually-acknowledged state. Concretely, add opponent **countersignatures** to the move protocol (each player signs the resulting state on receipt), and require `proposeForfeit`'s pivotal move to carry the accused's countersignature (proving they received it and it is genuinely their turn). A forked/withheld move, never countersigned, then cannot anchor a forfeit. This is a state-channel-grade protocol change (contract + app + server) and needs its own full audit.

---

[80] **2. `ForfeitPending` traps the honest winner (no proven-transcript escape)**

`MatchEscrow.proposeForfeit` / `finalizeForfeit` · Confidence: 80

**Description**
Once a match is forced into `ForfeitPending`, `proposeResult`/`challenge`/`settleSigned` all revert (they require `Active`/`Proposed`), so an honest winner holding a full terminal transcript **cannot settle the real result** — they are confined to a one-move rebuttal race under a ≥5-minute clock. Combined with the stale-accusation variant (a loser re-anchoring at an earlier real opponent-to-move ply), any single missed window pays an unproven claimant.

**Fix**
Let a proven terminal transcript settle a `ForfeitPending` match (accept `challenge`/`proposeResult` while `ForfeitPending`, paying the canonical winner) so an honest winner always has a one-transaction escape.

---

[75] **3. Forfeit griefing / TTL-refresh DoS**

`MatchEscrow.proposeForfeit` / `rebutForfeit` · Confidence: 75

**Description**
`proposeForfeit` is free (only gas), `challengeWindow` is only `MIN_CHALLENGE_WINDOW` (5 min), and each non-terminal `rebutForfeit` sets `activeDeadline = now + matchTtl` while advancing `lastRebuttedPly` by only one ply — so a losing player can re-open forfeits at successive plies, forcing the honest side to burn gas rebutting each and indefinitely postponing both settlement and the `voidExpired` refund. Bounded by game length, but every cycle is a fresh 5-minute steal-chance.

---

Findings List

| # | Confidence | Title |
|---|---|---|
| 1 | [95] | Forfeit-clock theft via forged (own-move-equivocated) prefix — 7 agents |
| 2 | [80] | ForfeitPending traps the honest winner |
| 3 | [75] | Forfeit griefing / TTL-refresh DoS |

---

## Leads

- **Client-side rebuttal is dead code** — `packages/app` — The app imports `rebutForfeit` but never calls it and has no `ForfeitProposed` listener, so the documented "the accused's own client can still rebut" fallback does not exist; the server keeper is the *sole* rebutter, turning any event-drop/restart into unanswered theft even for the (otherwise keeper-defendable) stale variant.
- **Keeper never opens a forfeit on abandonment** — `packages/game-server/src/keeper.ts` — `keeperActions` has no `proposeForfeit` branch, contradicting the contract doc ("the keeper opens a forfeit on detected abandonment before the TTL"); genuine abandonment therefore defaults to a mutual `voidExpired` refund (the loser escapes the loss) unless the winner's own client acts — the exact churn the clock was meant to fix.
- **`ForfeitRebutted` event is ambiguous** — `MatchEscrow.rebutForfeit` — emitted unconditionally *before* the terminal/resume branch, so a terminal rebuttal fires `ForfeitRebutted` ("resumed") and `MatchSettled` ("resolved") in one tx; an indexer keying off it shows a finished match as live. Emit only in the resume branch. (No fund impact.)

---

## Confirmed SOUND (regression — all 12 agents)

- **Finding-1 fix (`proposeResult` terminal proof):** no bypass. The winner is recomputed by `verify` and gated on `require(state.over)`; the opponent's moves are state-locked (can't be forged/spliced), so a fabricated terminal line is impossible and the removed attacker-controlled `commitment` is genuinely gone.
- **`moveDigest` state-binding:** closes cross-position splicing, cross-ply/cross-match replay, and transposition reuse (`noCaptureCount` + stores make recurring boards distinct). On-chain `stateHash` = `keccak(abi.encode(uint8[12] pits, store0, store1, turn, noCaptureCount))` is **byte-identical** to the off-chain `packages/protocol/src/eip712.ts` encoder and the engine — no move-bricking, no forgery. (Residual: *same-ply own-move* equivocation, which is harmless on the happy/proposeResult path but is the lever for Finding 1.)
- **`_payout` conservation:** every path pays exactly the match's own `2·stake` once (`prize + rake == pot`; draw `stake+stake`); CEI + `nonReentrant` on all settle entrypoints; no double-pay or strand across the forfeit/normal paths.
- **Engine ↔ contract parity:** AwaleRules sow/capture/grand-slam/feed/starvation/40-ply-split and the threefold-repetition `_endByCycle` match the TS engine exactly.
- **WeeklyPrizes / Treasury:** unchanged and clean (measured funding, per-round solvency, `msg.sender`-bound leaf, single-hash-leaf second-preimage infeasible, owner-only custody).

---

## Recommendation

The Finding-1 fix and the sig-binding hardening — the actual security-critical work — are **sound and should ship**. The **forfeit clock should be reverted**: making it sound requires countersigned (mutually-acknowledged) moves, a state-channel-grade protocol change that must be designed and audited on its own rather than rushed. The cash-game churn the clock targeted is a product problem that can be mitigated off-chain (reputation, abandonment penalties, matchmaking) while a countersigned-move forfeit is built properly for a later version.

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. Team security reviews, bug bounty programs, and on-chain monitoring are strongly recommended. For a consultation regarding your projects' security, visit [https://www.pashov.com](https://www.pashov.com)
