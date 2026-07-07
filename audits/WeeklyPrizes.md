# Security Review — `WeeklyPrizes`

| | |
|---|---|
| **Contract** | `contracts/src/WeeklyPrizes.sol` |
| **Type** | Merkle distributor (holds the Weekly-race pot, pays winners) |
| **Reviewer** | Author self-review (Pashov-style) — *not* an external audit |
| **Review date** | 2026-07-07 |
| **Dependencies** | OpenZeppelin v5.1.0 (`SafeERC20`, `ReentrancyGuard`, `Ownable`, `MerkleProof`) |

## Scope & purpose

`WeeklyPrizes` replaces the **custodial** Weekly-race payout (the server's
operator wallet sent each winner their prize from a private ledger) with an
on-chain **Merkle distributor**. Each week the operator funds that week's pot
INTO this contract and publishes a Merkle root over the winners; a winner then
claims from the **contract** with a proof. The money is escrowed and the winners
list is sealed on-chain, so a winner can collect what the published root owes
them even if the operator later disappears or turns hostile — the trust the
custodial model required is removed.

Leaf convention matches `HarvestVault` and the server's `buildPrizeTree`:
`leaf = keccak256(abi.encode(account, amount))`, OZ sorted-pair internals.

## Findings summary

| ID | Title | Severity | Status |
|---|---|---|---|
| L-01 | Privileged owner sets the root & funding | Low | Acknowledged (mitigated) |
| I-01 | `sweep` closes a round to further claims | Informational | By design |
| I-02 | Publish-time funding is trusted to match the root | Informational | By design |

No Critical/High/Medium findings.

## Low

### [L-01] Privileged owner sets the root & funding — *acknowledged (mitigated)*

The owner publishes each round's Merkle root and funds it. A malicious or buggy
owner could publish a root that misallocates the pot **among the funded amount**,
or under-fund a round. What it **cannot** do is the thing that mattered in the
custodial model:

- It can never pay out more than a round was funded (`claimed + amount <=
  funded`), and never reach another week's funds (per-round accounting) — so one
  bad root cannot drain the contract.
- Once a valid root is published, payment is enforced by the **contract**, not
  the server: the owner cannot then refuse a rightful winner, nor pay a
  non-winner (the leaf binds `msg.sender`).

**Mitigation:** the server publishes the full standings + claims file so anyone
can rebuild and verify the root; move ownership to the timelock + multisig
before mainnet (`Govern.s.sol`), so root publication is itself governed.

## Informational

### [I-01] `sweep` closes a round to further claims — *by design*

After `reclaimAfter`, `sweep` sends the unclaimed remainder to a chosen address
(rolled into next week's pot, or the treasury) and sets `claimed = funded`, which
also blocks any later claim for that round. This is intentional: the reclaim
window (30 days in practice) is long enough for any winner to collect, and
un-sweepable dust would otherwise accrete forever. Winners are notified at
rollover and greeted with a collect prompt on every app open.

### [I-02] Publish-time funding is trusted to match the root — *by design*

The owner must fund `amount >= sum(prizes in the root)`; the contract measures
the **actual received** amount (fee-on-transfer safe) and caps claims at it. If
the owner under-funds, some late claimants would hit `exceeds funding` — the same
fail-safe as HarvestVault's yield cap: the contract never lets total payouts
exceed what it holds for the round. Operationally the server funds exactly the
pot it split, so this is a backstop, not an expected path.

## Security properties confirmed

- **Escrowed, not custodial** — the pot lives in the contract; payment is
  contract-enforced against a sealed root (tested: `test_publish_pullsFunds…`,
  `test_claim_twoWinners_paidFromContract`).
- **Per-round solvency** — payouts never exceed a round's funding and one round
  can never drain another (`test_claim_revertExceedsFunding`,
  `test_claim_roundCannotDrainAnotherRound`; invariant `invariant_holdsWhatItOwes`,
  `invariant_noRoundOverspends`).
- **One claim per winner, winner-only** — `test_claim_revertDoubleClaim`,
  `test_claim_onlyWinnerCanClaim`, `test_claim_revertBadProof`.
- **No stuck funds** — `sweep` recovers the unclaimed remainder after the window
  (`test_sweep_recoversUnclaimedAfterWindow`), gated to the owner and the window.
- **Reentrancy** — `claim`/`sweep`/`publishRound` are `nonReentrant`, `SafeERC20`
  throughout, checks-effects-interactions (claimed marked before transfer).
- **Conservation** — invariant: received == held + claimed + swept.

## Conclusion

No Critical/High/Medium issues. The contract removes the custodial trust
assumption of the Weekly-race payout while preserving the one-tap collect UX.
The residual is the standard privileged-owner root publication (L-01), to be
placed behind governance before mainnet. An independent external audit is still
required before mainnet alongside the other contracts.
