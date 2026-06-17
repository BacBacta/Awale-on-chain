# Security Review — `ReplayVerifier`

| | |
|---|---|
| **Contract** | `contracts/src/ReplayVerifier.sol` |
| **Type** | Stateless verifier (`view`; no funds, no storage writes) |
| **Reviewer** | Author self-review (Pashov-style) — *not* an external audit |
| **Review date** | 2026-06-17 |
| **Branch** | `feat/contracts-rules-engine` |
| **Dependencies** | OpenZeppelin v5.1.0 (`ECDSA`, `MessageHashUtils`), `AwaleRules` |

## Scope & purpose

`ReplayVerifier` re-executes a disputed match from its signed transcript and returns
the canonical final `GameState`. Each move is an EIP-712 signature over
`(matchId, ply, house)` by the mover's per-match **session key** (an ephemeral
address). The contract recovers each signer, requires it to match whoever is to
move, and applies the move through `AwaleRules` (which reverts on any illegal move).
It holds no funds; `MatchEscrow` consumes its verdict.

## Findings summary

| ID | Title | Severity | Status |
|---|---|---|---|
| M-01 | Unbounded transcript length enables gas-griefing | Medium | **Resolved** |
| I-01 | `transcriptHash` is currently unused | Informational | By design |
| I-02 | Session keys are not bound to a match here | Informational | By design |

No Critical/High/Low findings.

---

## Medium

### [M-01] Unbounded transcript length enables gas-griefing — **Resolved**

**Description.** `verify` loops over `t.moves`, doing an `ecrecover` and a full
`applyMove` per ply. The array length was unbounded, so a caller could submit an
enormous transcript whose replay exceeds the block gas limit, or grief by forcing
the honest party to pay for a needlessly long replay during a `challenge`.

**Impact:** Medium — no fund loss (the function is `view` and the caller pays its
own gas), but a dispute could be made arbitrarily expensive or impossible to land
on-chain.

**Resolution.** Added `MAX_PLIES = 4096` and `require(t.moves.length <= MAX_PLIES)`.
Awalé games without repetition terminate in far fewer plies; cyclic positions are
adjudicated off-chain (see `AwaleRules` I-01), so the cap does not exclude any
legitimate terminal game.

---

## Informational

### [I-01] `transcriptHash` is currently unused — *by design*

`transcriptHash(matchId, startTurn, moves)` is provided for a future optimistic
settlement variant and for state-channel close (architecture §7, §11), where only a
hash is posted on-chain and the full transcript is revealed on dispute. The current
`MatchEscrow` flow replays the full transcript directly, so the helper has no
callers yet. Kept intentionally; it is `pure` and cannot affect state.

### [I-02] Session keys are not bound to a match inside the verifier — *by design*

`verify` takes `session0`/`session1` as parameters and only checks internal
consistency (per-ply signer, illegal moves, EIP-712 domain). It does **not** know
the keys registered for `matchId` on-chain. Binding the transcript's sessions and
`startTurn` to the match's registered values is `MatchEscrow.challenge`'s
responsibility, and it does enforce exactly that. Documented so integrators never
call `verify` in isolation as an authorisation oracle.

---

## Security properties confirmed

- **Cross-chain / cross-contract replay protection** — the EIP-712 domain separator
  binds `block.chainid` and `address(this)`; `matchId` and `ply` bind a signature to
  one match and one position. Verified by `test_revert_crossMatchReplay`.
- **No signature malleability / zero-address bypass** — uses OZ `ECDSA.recover`,
  which reverts on malformed signatures rather than returning `address(0)`.
- **An invalid transcript can never produce an outcome** — wrong signer, wrong
  mover, illegal move, and any move after game-over all revert (tested).
- **Deterministic agreement with the engine** — `test_verify_fullGameOutcomeMatchesEngine`.

## Conclusion

One Medium (gas-griefing) found and resolved with a length cap. Remaining items are
intentional design boundaries. The verifier is a thin, side-effect-free wrapper over
the audited `AwaleRules` engine with sound EIP-712 replay protection.
