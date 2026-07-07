# 🔐 3rd Security Re-Audit — Awale-on-chain v2 acknowledged-turn forfeit

---

## Scope

|                                  |                                                        |
| -------------------------------- | ------------------------------------------------------ |
| **Mode**                         | Re-audit of the v2 forfeit fix (12 agents)             |
| **Target**                       | `proposeForfeit(matchId, t, ackSig)` + `ReplayVerifier.ackDigest` (the acknowledged-turn anti-fabrication anchor) |
| **Files reviewed**               | `MatchEscrow.sol` · `ReplayVerifier.sol` · `AwaleRules.sol`<br>`WeeklyPrizes.sol` · `Treasury.sol` + off-chain stack |
| **Method**                       | Pashov 12-agent re-audit → dedup → gates                |

---

## Verdict

**The v2 ack gate SOUNDLY closes the v1 own-move-equivocation theft — UNANIMOUS (12/12).** Every agent independently confirmed, with concrete traces, that a claimant cannot fabricate an "opponent-to-move" position: they cannot produce the accused's ack for a forked/withheld state, `acked ⟺ rebuttable`, the `ackDigest` is byte-exact vs off-chain, ECDSA is safe, and no collision/replay/typehash-confusion path exists. **No new contract theft was found.** proposeResult, sig-binding, WeeklyPrizes, Treasury, and `_payout` conservation all regressed clean.

**But the re-audit surfaced two things that make v2 not yet shippable:**

---

## Findings

[—] **1. The forfeit clock is INERT — the ack is never produced or relayed** (8-agent convergence)

`packages/app` + `packages/game-server` (off-chain integration) · **not a contract flaw**

**Description**
`proposeForfeit` hard-requires the accused's `ackSig`, but **`signAck` has zero call sites** anywhere in production: the client never signs an ack on receiving a turn-flipping move, the server never relays/stores one (`emitClaimEligible` carries no `ackSig`), and the keeper never calls `proposeForfeit`. So `proposeForfeit` is **unreachable** — every mid-game abandonment falls to the `voidExpired` TTL refund. The deterrent ("abandonment costs the pot") is currently 100% off, and a losing player rage-quits for a free refund. This is the pending game-flow integration, known and expected — but until it's wired, v2 delivers nothing over refund-on-abandon.

**Fix** — wire it end-to-end: the accused's client `signAck`s in the `"state"` move-receive handler and emits it; the server persists the latest per-player ack and includes it as `ackSig` in `claim-eligible`.

---

[75] **2. Stale-ack reach-back — griefing that escalates to theft on a keeper+winner liveness lapse**

`MatchEscrow.proposeForfeit` / `rebutForfeit` / `finalizeForfeit` · Confidence: 75 · (invariant FINDING; access-control/trust-gap/economic/math-precision/periphery LEADs)

**Description**
The ack proves the accused *acknowledged it was their turn* at a position — **not that they failed to move from it**. Because the accused auto-acks *every* turn, the counterparty accumulates a valid ack for every past accused-turn. `proposeForfeit` only gates `t.moves.length > lastRebuttedPly` (initial 0), so a player who **already lost/drew** a finished-but-unsettled (`Active`) game can open a forfeit at an *old* real ply (real prefix, real ack) naming themselves winner. During `ForfeitPending` the true winner cannot `proposeResult`/`challenge` (they require `Active`/`Proposed`), and `rebutForfeit` only advances one ply — so the loser forces a per-ply rebuttal gauntlet, and **if the winner AND the keeper both miss one ≥5-min window, `finalizeForfeit` pays the loser the whole pot of a game they lost.** This is beyond the accepted "offline-before-receiving → refund" residual: the victim already won, and the loser is *paid*.

**Fix**
- `rebutForfeit` accepts a longer transcript that advances `lastRebuttedPly` to the **proven frontier** (one rebuttal kills all stale forfeits below it), and
- allow `proposeResult`/`challenge` (a terminal transcript that extends the committed prefix) to **settle a `ForfeitPending`** match to the canonical winner in one tx.

This reduces the reach-back theft to "the keeper is entirely down for the full window" — the standard keeper-liveness assumption — but does **not** make it keeper-independent (see Conclusion).

---

[70] **3. The accused has no client-side rebuttal — sole defense is the server keeper**

`packages/app` (off-chain) · Confidence: 70 · (periphery)

**Description**
The app exports `rebutForfeit` but **never calls it**, and the accused's chain-poll doesn't react to a `ForfeitPending` against them. So once the ack is wired, the accused's only defense against a stale-ack reach-back is the server keeper — which contradicts the "robust to a malicious server" goal: a **colluding/malicious server + opponent** replaying a genuine earlier-ply ack steals the pot, because the accused's client can't self-rebut.

**Fix** — wire a client-side `ForfeitProposed` watcher that auto-`rebutForfeit`s (from the client's own transcript) when it is the accused, so defense never depends solely on the server.

---

Findings List

| # | Confidence | Title |
|---|---|---|
| 1 | — | Forfeit inert: ack never produced/relayed (integration gap) |
| 2 | [75] | Stale-ack reach-back → theft on keeper+winner liveness lapse |
| 3 | [70] | No client-side rebuttal → sole defense is the (trusted) keeper |

---

## Confirmed SOUND (unanimous)

- **The v1 own-move-equivocation theft is genuinely closed.** You cannot forfeit a position the accused didn't acknowledge; `acked ⟺ rebuttable` (a non-terminal Awalé state always has a legal move); no fork, transposition, cross-ply/match/state replay, or Move↔TurnAck confusion succeeds.
- **`ackDigest`/`stateHash`/`moveDigest` byte-exact parity** with `packages/protocol/src/eip712.ts` (pinned by the parity vector); ECDSA (OZ 5.1.0) reverts on bad/malleable/zero.
- **proposeResult** terminal proof, `_payout` conservation, no stuck funds / no double-settle, **WeeklyPrizes**, **Treasury** — all clean.

---

## Conclusion & recommendation

v2 achieved its contract-level goal: the unconditional fabrication theft of v1 is gone. But the re-audit confirms a **fundamental limit**: the forfeit clock cannot distinguish "abandoned at the frontier" from "reached back to an old acknowledged turn" on-chain, because the abandoner never signs the frontier they abandon. The reach-back is therefore only defendable by a live rebutter (winner or keeper) — so a **fully keeper-independent, theft-free, churn-solving forfeit does not exist trustlessly.** Making v2 shippable requires: (a) wiring the ack end-to-end, (b) a client-side rebuttal watcher, (c) the reach-back hardening (rebut-to-frontier + terminal-settle-in-ForfeitPending) — and it still reduces to a keeper-liveness assumption, plus a 4th re-audit.

**The Finding-1 fix and the sig-binding hardening remain sound and ship-ready.** The strategic choice is between completing the substantial v2 integration+hardening (accepting keeper-liveness for the reach-back) and deferring the on-chain forfeit clock in favour of off-chain churn mitigation.

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. Team security reviews, bug bounty programs, and on-chain monitoring are strongly recommended. For a consultation regarding your projects' security, visit [https://www.pashov.com](https://www.pashov.com)
