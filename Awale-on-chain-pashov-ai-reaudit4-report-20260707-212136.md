# 🔐 4th Security Re-Audit — Awale-on-chain hardened forfeit (leapfrog + poll-defense)

---

## Scope

|                                  |                                                        |
| -------------------------------- | ------------------------------------------------------ |
| **Mode**                         | Re-audit of the reach-back hardening (12 agents)       |
| **Target**                       | `rebutForfeit` leapfrog (accepts any longer valid continuation → advances `lastRebuttedPly` to frontier / settles terminal) + keeper poll-defense |
| **Files reviewed**               | `MatchEscrow.sol` · `ReplayVerifier.sol` · `AwaleRules.sol`<br>`WeeklyPrizes.sol` · `Treasury.sol` + off-chain ack/keeper wiring |
| **Method**                       | Pashov 12-agent re-audit → dedup → gates (11 substantive reports; 1 agent hit an infra session limit, its ground covered by others) |

---

## Verdict

**The leapfrog hardening CLOSES the 3rd-audit stale-ack reach-back pot theft** (unanimous): the true winner (or keeper) rebuts with the full terminal transcript and `_payout(state2.winner)` pays the **canonical** winner, never the loser; the committed prefix is forced onto the real line by the ack gate, so the winner's real continuation always exists to extend it. The v2 ack gate still closes the v1 own-move-equivocation theft. All value regression (proposeResult, sig-binding, WeeklyPrizes, Treasury, `_payout` conservation) is clean.

**One new defect was found and FIXED in this pass:** an off-by-one in the leapfrog anti-replay floor.

---

## Findings

[85] **1. Off-by-one leapfrog floor — the live frontier ply becomes un-forfeitable** — **FIXED**

`MatchEscrow.rebutForfeit` / `proposeForfeit` · Confidence: 85 · **4-agent convergence** (access-control, first-principles, boundary, invariant FINDINGs; execution-trace, asymmetry LEADs)

**Description**
A non-terminal rebuttal set `lastRebuttedPly = t2.moves.length` (the frontier length L), but the rebuttal only *proves* the moves at indices `0..L-1`; the player to move at ply `L` (the live, resumed frontier) has not answered. Because `proposeForfeit` gates with `t.moves.length > lastRebuttedPly`, a fresh, legitimate forfeit at exactly ply `L` reverted `"stale forfeit ply"`. So a **losing player could bait a rebuttal** (open a stale sub-frontier forfeit → force the winner/keeper to rebut → floor leapfrogs to the frontier) and then **abandon at the frontier, now un-forfeitable → only `voidExpired` refund**. This defeated the "abandonment costs the pot" deterrent for every match, and handed the abandoner a free upside (if the defender was late, `finalizeForfeit` paid them the pot outright). It is distinct from the accepted "offline / keeper-down" residuals — the winner and keeper are fully online and defend correctly, yet the floor off-by-one still robs the deterrent.

**Fix (applied)**
```diff
-            m.lastRebuttedPly = uint32(t2.moves.length);
+            // the highest ANSWERED ply is frontier length − 1; the mover at the
+            // live frontier ply L has not answered, so keep it forfeitable
+            m.lastRebuttedPly = uint32(t2.moves.length) - 1;
```
Now a forfeit at the frontier ply `L` passes (`L > L-1`) while every proven ply `≤ L-1` stays blocked (no gauntlet, no reach-back). Regression test `test_forfeit_frontierForfeitableAfterRebuttal` added; suite green.

---

Findings List

| # | Confidence | Title | Status |
|---|---|---|---|
| 1 | [85] | Off-by-one leapfrog floor → frontier un-forfeitable | **Fixed** |

---

## Leads

- **MAX_PLIES boundary coupling** — `ReplayVerifier.MAX_PLIES` — the accused's ability to rebut relies on a real Awalé game terminating (~1000 plies via the 40-ply no-capture split + ≤24 captures) strictly below `MAX_PLIES = 4096`; if `forfeitPly` could reach `MAX_PLIES`, no valid rebuttal (length > 4096) could exist → forfeit-lockout. Unreachable today; **documented as an in-code invariant** so a future change to `NO_CAPTURE_LIMIT` / capture bounds / `MAX_PLIES` can't silently break it.
- **No client-side rebuttal watcher (single-rebutter trust)** — `packages/app` — the app exports `rebutForfeit` but wires no `ForfeitProposed` watcher, so the *automatic* defense against a stale forfeit is the server keeper alone; a malicious/colluding server could withhold the rebuttal. The keeper poll-defense (event-independent, mirror-exact with the contract guard) covers the honest-operator case; a client-side watcher (needs the client to accumulate both players' move sigs — a realtime protocol change) would remove the last server-trust anchor. **Known / tracked hardening.**

---

## Confirmed SOUND (this pass)

- **Reach-back pot theft CLOSED** — terminal `rebutForfeit` pays the verifier's canonical winner (never the caller); a losing claimant cannot fabricate a favorable continuation (every opponent ply needs the opponent's position-bound signature). Reduced to the accepted "winner AND keeper both offline the whole window" residual.
- **v1 fabrication theft still CLOSED** — the ack gate (accused's `ackDigest` over the exact position) is unchanged; `acked ⟺ rebuttable`.
- **Leapfrog cannot be inflated past real progress** (`verify` re-checks every ply) so it can never lock out a legitimate future forfeit; `_prefixHash` still binds the rebuttal to the committed prefix byte-for-byte; `uint32(t2.moves.length)` is bounded by `MAX_PLIES`; the terminal branch's un-reset `forfeitPrefix`/`forfeitPly` are dead storage (status → Resolved).
- **Keeper poll-defense correct** — `forfeitRebuttal` returns the full hub transcript iff `hub.length > forfeitPly` (mirror-exact with the contract's `> forfeitPly` guard): genuine abandonment falls through to `finalizeForfeit`, a stale/false claim is defeated; a malicious rebutter can cause no wrong payout (both exits pay a replay-proven winner or require unforgeable real moves).
- **Ack wired end-to-end** — app auto-signs the TurnAck on its turn; server relays the loser's ack in `claim-eligible`; `ackDigest` byte-exact. The forfeit is now reachable in production; honest abandonment settles to the claimant.
- **proposeResult / challenge, WeeklyPrizes, Treasury, `_payout` conservation** — unchanged and clean.

---

## Conclusion

After the off-by-one fix, the forfeit clock reaches its design target under the stated trust model: the fabrication theft and the reach-back pot theft are both closed, and the residual is exactly the accepted trustless boundary — an honest rebutter (the accused's client OR the keeper) must be online for one challenge window. The remaining hardening (a client-side rebuttal watcher to defend even a malicious server) is tracked. Recommend a final human security review of the fixed forfeit clock before mainnet.

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. Team security reviews, bug bounty programs, and on-chain monitoring are strongly recommended. For a consultation regarding your projects' security, visit [https://www.pashov.com](https://www.pashov.com)
