# Security Review — `AwaleRules`

| | |
|---|---|
| **Contract** | `contracts/src/AwaleRules.sol` |
| **Type** | Pure library (no storage, no funds, no external calls) |
| **Reviewer** | Author self-review (Pashov-style) — *not* an external audit |
| **Review date** | 2026-06-17 |
| **Branch** | `feat/contracts-rules-engine` |
| **Dependencies** | none |

## Scope & purpose

`AwaleRules` is a deterministic implementation of the **Oware Abapa** rules. It is
the shared source of truth for both the off-chain game server (via the TypeScript
port in `packages/engine`) and the on-chain `ReplayVerifier`. Its only security
obligation is **determinism and correctness**: identical inputs must produce
byte-identical outputs everywhere, and it must never accept an illegal move.

The library holds no value and makes no external calls, so classic smart-contract
attack surface (reentrancy, access control, fund flows) does not apply. The risk
is entirely *logical*: a rules bug would let a dishonest transcript replay to a
false winner, or cause the on-chain and off-chain engines to disagree.

## Findings summary

| ID | Title | Severity | Status |
|---|---|---|---|
| I-01 | Cyclic (non-terminating) positions are not resolved on-chain | Informational | Acknowledged |
| I-02 | Turn ownership is caller-supplied | Informational | By design |
| G-01 | `legalMovesMask` re-simulates sowing for the feeding check | Gas | Acknowledged |

No Critical/High/Medium/Low findings.

---

## Informational

### [I-02] Turn ownership is caller-supplied — *by design*

`applyMove` trusts `s.turn` to identify the mover; the library does not know which
ephemeral key owns which side. This is intentional: binding moves to session keys
and a specific match is the job of the layer above (`ReplayVerifier` recovers the
signer per ply and checks it against the registered key; `MatchEscrow` binds the
transcript to the match). The library is deliberately signature- and identity-agnostic.

### [I-01] Cyclic positions are not resolved on-chain — *acknowledged*

Oware can reach positions that cycle forever with no further captures. Competition
rules resolve this by ending the game and splitting the board. The engine implements
only the *explicit* terminal conditions (a store passing 24, and starvation
collection); it does not detect repetition. This is acceptable because:

- a dispute is about *moves*, and every move in a submitted transcript is still
  validated and replayed faithfully;
- cycle adjudication (split the board) is an off-chain refereeing decision that both
  clients can compute identically, and a contested cycle would surface as a
  non-terminal transcript, which `MatchEscrow.challenge` already handles by voiding
  and refunding.

**Recommendation:** if on-chain cycle resolution is ever required, add a
repetition/threefold rule behind an explicit `resolveCycle` entry point rather than
inside `applyMove`, to keep the move function total and cheap.

## Gas

### [G-01] `legalMovesMask` re-simulates a full sow per candidate house

When the opponent has no seeds, the feeding-obligation check sows each candidate
house to see whether it reaches the opponent. This is O(houses × seeds) and only
triggers in the rare starvation branch, so it is left as-is for clarity.

---

## Verification & invariants

The following are enforced by the test suite (`contracts/test/AwaleRules.t.sol`,
`packages/engine/test`):

- **Seed conservation** — `Σ pits + store0 + store1 == 48` after every ply, checked
  in a 5000-ply deterministic self-play and a 256-run fuzz.
- **No illegal move accepted** — empty house, out-of-range house, move-after-over,
  and non-feeding moves under starvation all revert.
- **Grand-slam, backward capture, origin-skip, win-at-25, draw-by-collection** —
  hand-derived unit tests.
- **Cross-language parity** — the TypeScript port reproduces 40 Solidity-generated
  games byte-for-byte, including a rolling hash over every intermediate state.

## Conclusion

No security-relevant defects found. The library is small, total over its validated
input domain, and proven equivalent across its two runtimes. Residual risk is
limited to the acknowledged cycle-resolution scope decision.
