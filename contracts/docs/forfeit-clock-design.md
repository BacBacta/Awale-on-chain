# On-chain forfeit clock — design spec

**Status:** v2 (acknowledged-turn). The **v1 clock below (proposeForfeit/rebutForfeit/finalizeForfeit with a claimant-chosen prefix) is UNSOUND** — the 12-agent re-audit (`Awale-on-chain-pashov-ai-reaudit-report-20260707-195418.md`) found a critical (7-agent convergence): a player can sign a legal-but-never-played move for their OWN turn (own-move equivocation — `moveDigest` binds the position, not which legal move is chosen), forking onto a branch the opponent never signed, fabricating "it's the opponent's turn," which neither the keeper (slices the real hub transcript → "prefix mismatch") nor an offline opponent can rebut → `finalizeForfeit` steals the pot. This section is kept for the record; the sound redesign is below.

---

# v2 — Acknowledged-turn forfeit (the sound design)

**Root cause of v1:** the forfeit trusted a claimant-chosen prefix as the canonical line, but a player can fabricate "opponent to move" out of their own signature. You cannot, on-chain, distinguish a real forfeit from a fabricated one **unless the accused signed that it is their turn.**

**Fix:** you may only forfeit the opponent at a position the opponent **explicitly acknowledged**.

- New EIP-712 signature **`TurnAck`**: `ackDigest(matchId, ply, state)` where `state = stateHash(pre-move position)`. A player's client signs this **automatically upon receiving the opponent's move that hands them the turn** — "I acknowledge that at this exact state it is ply `ply` and my move." The server relays it to the opponent.
- **`proposeForfeit(matchId, t, ackSig)`** additionally requires `ackSig` to be the **accused's** session-key signature over `ackDigest(matchId, t.moves.length, stateHash(state))`, where `state` is the replayed position at the end of `t` (the accused's turn).

**Why the fork is closed:** the flipping move (the claimant's move at the end of the prefix) produces `state`; `ackDigest` binds `stateHash(state)`; the accused only ever signs an ack for a state their client actually **received**. A forked/withheld move yields a `state` the accused never saw → no valid `ackSig` → `proposeForfeit` reverts. A player cannot forge the accused's session key. The ply-0/first-mover fabrication is closed the same way (no ack exists).

**Stale claim** (real prefix, accused's ack real, but the accused already moved on): still rebuttable — the accused/keeper submits the accused's real next move (`rebutForfeit`), exactly as v1.

**Honest security properties (stated plainly, including the limits):**
- ✅ **No theft.** By construction you can only forfeit a turn the accused's own key acknowledged; nothing can be fabricated.
- ✅ **Churn strongly reduced.** A losing player's client auto-acks each turn on receipt, so they **cannot abandon on their own turn** (already acked → forfeitable). To escape they must abandon **blind, during the opponent's turn**, before seeing the result — a much weaker, pre-emptive incentive.
- ⚠️ **Residual (irreducible).** A player who goes offline *before receiving* the opponent's move never acks that turn → cannot be forfeited → `voidExpired` refund. This is the fundamental trustless limit (you cannot force a party to sign). Mitigated **off-chain** (reputation, abandonment penalties, matchmaking) — never by fabricating an on-chain signature.

**Off-chain changes (lockstep):** app auto-signs `TurnAck` on receiving a turn-flipping move and relays it; the winner's `selfClaim`/`proposeForfeit` includes the loser's ack; the server relays+stores acks; **the client rebuttal watcher (`ForfeitProposed` → `rebutForfeit`) — dead code in v1 — is wired** so an online accused defends automatically. Keeper backstop unchanged (rebuts stale claims from the hub).

**This v2 surface MUST pass its own (3rd) 12-agent re-audit before mainnet.**

---

# v1 (UNSOUND — kept for the record)

**Status:** proposal, pre-implementation. Reviewed against the Pashov audit that produced Finding-1 (attacker-controlled `proposeResult` commitment). This mechanism is *new attack surface* and MUST go through the same 12-agent audit before mainnet.

## Problem

After the Finding-1 fix, a winner can only be settled on-chain when the game reaches a **terminal** state (`proposeResult(terminalTranscript)` / `settleSigned`). A game abandoned **mid-play** has no on-chain-provable winner, so the only safe resolution is a refund (`voidExpired` after TTL).

For a **cash game** that is a hole: a player who is losing abandons mid-game to force a refund and escape the loss. The skilled/winning player is denied their win → churn. Refund alone makes losing free.

## Goal

Make "my opponent abandoned while it was their move → I win the pot" **enforceable without any trusted referee**. The construction must leave an abandoning player exactly two exits, **neither of which is a refund**:

1. **Forfeit** → the present player wins the pot, or
2. **Keep playing** (respond with real moves) → the game continues to its true terminal → they lose for real.

The refund path must become unreachable once a forfeit is claimed.

## Non-goals

- Not a general dispute layer. `settleSigned` (both agree) and `proposeResult` (prove a finished game) stay as-is.
- Not a full on-chain game engine. On-chain moves happen only in the (rare) contested case and are self-limiting.
- Does not defend a player who is **both** genuinely present **and** refuses to watch the chain **and** has no keeper — see *Liveness assumptions*.

## Core idea

A game is alternating signed moves; at any non-terminal point it is **exactly one player's turn**. The player whose turn it is and who fails to move is, by definition, the abandoner. We make that provable:

- The present player posts the mutually-signed transcript up to a non-terminal point where **it is the opponent's turn**, starting an on-chain response window.
- The accused (or anyone on their behalf — the keeper) rebuts by posting the **opponent's next legal signed move** on-chain. A valid move proves presence.
- No valid rebuttal before the window closes → the accused abandoned → the claimant wins the pot.

Because a rebuttal is a *real move*, the accused cannot both "not abandon" and "not play": to dodge the forfeit they must advance the game, which walks them toward their real (losing) terminal.

## State machine

```
                       proposeForfeit(prefix ending on opponent's turn)
        Active  ───────────────────────────────────────────────►  ForfeitPending
          ▲                                                            │
          │ rebutForfeit(prefix + 1 legal signed move)   [non-terminal]│
          └────────────────────────────────────────────────────────────┤
                                                                        │
   rebutForfeit(prefix + 1 move)  [move ends game]  ──►  _payout(canonicalWinner) ─► Resolved
                                                                        │
   finalizeForfeit()  [window elapsed, no rebuttal]  ──►  _payout(claimant)       ─► Resolved
```

`ForfeitPending` is added to the `Status` enum. `voidExpired` excludes it (like `Proposed`): a forfeit always has a resolution path forward (`rebutForfeit` or `finalizeForfeit`), so funds are never stuck.

## Functions

### `proposeForfeit(uint256 matchId, ReplayVerifier.Transcript calldata t)`
Guards / effects:
- `m.status == Active`
- `block.timestamp <= m.activeDeadline` (can't start a forfeit on an already-expired match — that's `voidExpired`'s refund)
- `m.startTurn != START_UNSET`
- Derive the state at the end of the submitted prefix:
  - if `t.moves.length == 0`: `state = initialState()`, `state.turn = m.startTurn` (handles "first mover never moved"; no sigs to verify)
  - else: bind `t` to the match (`t.matchId/session0/session1/startTurn` == match) and `state = verifier.verify(t)`; `require(!state.over)`
- `accused = state.turn == 0 ? m.player0 : m.player1`; `claimant = the other player`
- `require(msg.sender == claimant)` — you can only forfeit-claim your **opponent**, never yourself, and never on your own turn
- **anti-replay / anti-spam:** `require(t.moves.length > m.lastRebuttedPly)` — a new forfeit must sit strictly past the last successfully-rebutted ply, so a stale claim can't be re-spammed after it was answered (forfeit progress is tied to real game progress)
- store: `forfeitPrefix = transcriptHash(matchId, startTurn, t.moves)`, `forfeitPly = t.moves.length`, `proposedWinner = claimantIndex`, `challengeDeadline = now + challengeWindow` (reuse the field), `status = ForfeitPending`
- emit `ForfeitProposed(matchId, claimantIndex, forfeitPly, deadline)`

### `rebutForfeit(uint256 matchId, ReplayVerifier.Transcript calldata t2)` — permissionless, nonReentrant
A valid rebuttal can only ever help the accused (prove presence / advance / end to the true winner), so **anyone** (the keeper) may submit it.
- `m.status == ForfeitPending`
- `block.timestamp <= m.challengeDeadline`
- bind `t2` to the match; `require(t2.moves.length == m.forfeitPly + 1)` — exactly one move past the claimed point
- `require(transcriptHash(matchId, startTurn, t2.moves[0..forfeitPly]) == m.forfeitPrefix)` — same prefix, so the extra move is the accused's move at `forfeitPly`
  - *(implementation: recompute the prefix hash over the first `forfeitPly` moves and compare; the (forfeitPly)-th move is by the accused because `verify` enforces per-ply signer = whose turn it is)*
- `state2 = verifier.verify(t2)` — this **enforces the extra move is legal and signed by the accused**
- resolution:
  - if `state2.over`: `_payout(matchId, m, state2.winner)` → `Resolved` (the accused answered with the game-ending move; the true winner is paid — a grief right before losing backfires)
  - else: `m.lastRebuttedPly = m.forfeitPly`; `m.status = Active`; `m.activeDeadline = now + matchTtl` (refresh TTL so the resumed game isn't instantly `voidExpired`-able); emit `ForfeitRebutted(matchId, forfeitPly)`
- emit as appropriate

### `finalizeForfeit(uint256 matchId)` — permissionless, nonReentrant
- `m.status == ForfeitPending`
- `block.timestamp > m.challengeDeadline`
- `_payout(matchId, m, m.proposedWinner)` (the claimant wins the pot, normal rake) → `Resolved`
- emit `ForfeitFinalized(matchId, proposedWinner)`

## Why this closes the churn escape

Take a player losing at ply 20, whose turn it is (they must make a bad move):
1. They abandon. The present player (or keeper) calls `proposeForfeit` on the 0..19 prefix (`state.turn` = the abandoner).
2. To avoid losing the pot the abandoner must `rebutForfeit` with their real move 20 — i.e. **keep playing**. That resumes the game they were losing → they reach terminal and lose via `proposeResult`/`settleSigned` anyway.
3. If they don't respond, `finalizeForfeit` pays the pot to the present player.

`voidExpired` (refund) is blocked the whole time (`ForfeitPending` excluded), and the keeper calls `proposeForfeit` on detected abandonment **before** the TTL, so the abandoner can't slip out through the refund window either. **No exit leads to a refund of a game you were losing.**

## Security analysis (attack table)

| # | Attack | Defense |
|---|---|---|
| 1 | Claimant lies that a *present* opponent abandoned | Opponent/keeper `rebutForfeit`s with the real move → denied. Same trust model as the existing H-03 keeper backstop. |
| 2 | Claimant submits a **stale** early state (game is really further along) to gain edge | Rebuttal with the already-existing signed move at that ply denies it; `lastRebuttedPly` monotonicity stops re-spamming the stale ply. |
| 3 | Losing claimant "claims a win" via forfeit | Impossible: you can only claim when it's the **opponent's** turn (`msg.sender == claimant`, `accused == state.turn`). The opponent always has a legal move to rebut (a non-terminal Awalé state always has one; no-legal-move ⇒ `state.over`). |
| 4 | Grief: force the opponent to burn gas by forfeit-claiming every turn | `lastRebuttedPly` monotonicity ties each claim to genuine game progress; the keeper (not the player) pays to rebut; repeat false-claimants are flagged off-chain. Residual — see *Open decisions* (optional claimant bond). |
| 5 | Ping-pong drags the whole game on-chain | Self-limiting: each on-chain move costs the mover gas and whoever stops responding loses. In practice the abandoner simply doesn't respond → one `finalizeForfeit`. |
| 6 | Reentrancy on payout | `rebutForfeit`/`finalizeForfeit` are `nonReentrant`; `_payout` is CEI (status set before transfers). |
| 7 | Accused equivocates: rebuts with a different move than played off-chain | Only changes the accused's **own** move; not a theft vector (opponent's moves are pinned by the prefix). Interacts with the audit's ply-equivocation lead → see *Companion hardening*. |

## Liveness assumptions (must be documented in-code)

- Correctness never depends on the keeper. **Liveness does:** a genuinely-present player who ignores the chain, has no keeper, and never rebuts within the window can be wrongly forfeited. Mitigations: window ≥ `MIN_CHALLENGE_WINDOW` (5 min, reused), the keeper auto-rebuts false claims (it runs the hub and holds every signed move), and a player can always self-rebut.
- The keeper drives the **honest** side of both roles: it `proposeForfeit`s on detected abandonment (before TTL) and `rebutForfeit`s false claims. This matches the current keeper's role for `proposeResult`.

## Companion hardening (recommended, separate lead from the audit)

Bind each move signature to the **prior board state**, not just `(matchId, ply, house)`:
`moveDigest = keccak(matchId, ply, house, priorStateHash)`. This makes a ply's signature unique to its position, closing the audit's **ply-equivocation** lead and making the forfeit rebuttal history unforkable. This is a `ReplayVerifier` + client change; recommend shipping it together with the forfeit clock since they touch the same signing scheme.

## Storage delta (`Match` struct)

Reuse where a match can only be in one mode at a time:
- `proposedWinner` (uint8) — reused to hold the forfeit **claimant** index.
- `challengeDeadline` (uint64) — reused as the forfeit **deadline**.
- **new** `bytes32 forfeitPrefix` — reoccupies the slot freed by Finding-1's removed `transcriptCommitment`.
- **new** `uint32 forfeitPly`, `uint32 lastRebuttedPly` — pack into one slot.

## Decisions (signed off 2026-07-07)

1. **Forfeit payout size → full pot minus normal rake.** Abandonment pays the present player exactly like a normal win. This is the deterrent.
2. **Window → reuse `challengeWindow` (≥ `MIN_CHALLENGE_WINDOW` = 5 min).** No new parameter/storage; a match is never `Proposed` and `ForfeitPending` at once, so `challengeDeadline`/`challengeWindow` are shared.
3. **Anti-spam → keeper-rebuts + off-chain reputation. No on-chain bond at launch.** Revisit with a slashable claimant bond only if telemetry shows abuse.
4. **Sig-binding hardening ships NOW, with the clock.** `moveDigest` binds the prior board-state hash so each ply signature is unique to its position — closes the ply-equivocation lead and makes forfeit history unforkable. This changes the signing scheme across contract + engine + app in lockstep.
```
