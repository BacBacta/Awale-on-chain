# Security Review — `HarvestVault`

| | |
|---|---|
| **Contract** | `contracts/src/HarvestVault.sol` (+ `interfaces/ILendingPool.sol`) |
| **Type** | No-loss yield vault (holds user funds, integrates an external lending market) |
| **Reviewer** | Author self-review (Pashov-style) — *not* an external audit |
| **Review date** | 2026-06-17 |
| **Branch** | `feat/contracts-rules-engine` |
| **Dependencies** | OpenZeppelin v5.1.0 (`SafeERC20`, `ReentrancyGuard`, `Ownable`, `MerkleProof`); external lending pool (Aave V3 / Moola) |

## Scope & purpose

`HarvestVault` runs the no-loss league: deposits are supplied to a Celo lending
market, and at season end the vault withdraws everything, returns **every player's
principal in full**, and distributes the **yield** to the leaderboard via a Merkle
root. It custodies user funds and depends on an external lending market, so it
carries both internal and integration risk.

## Findings summary

| ID | Title | Severity | Status |
|---|---|---|---|
| M-01 | State written after the external `withdraw` in `finalize` | Medium | **Mitigated** |
| M-02 | No-loss depends on lending-market solvency | Medium | **Hardened (pro-rata)** — external risk remains |
| L-01 | Prize Merkle root is trusted to reflect true standings | Low | Acknowledged |
| L-02 | Privileged owner / keeper | Low | Acknowledged |
| I-01 | One active season per token limits throughput | Informational | By design |
| I-02 | `block.timestamp` window comparisons | Informational | By design |

No Critical/High findings.

---

## Medium

### [M-01] State written after the external `withdraw` in `finalize` — **Mitigated**

**Description.** `finalize` calls `pool.withdraw(...)` and then writes
`redeemed`, `yieldPot`, and `prizeMerkleRoot` from the call's result (Slither
`reentrancy-no-eth`). Writing state after an external call is the classic
reentrancy shape.

**Why it is not exploitable here:**
- `finalize`, `deposit`, `claimPrincipal`, `claimPrize`, and `createSeason` are all
  `nonReentrant` and share one guard, so the lending pool cannot re-enter any
  state-changing path during the withdraw;
- `finalize` is `onlyOwner`;
- the `pool` is an owner-chosen, allowlisted, audited lending market (a trusted
  integration, not arbitrary user input).

The post-call writes are unavoidable because `yieldPot` is derived from the
withdraw return value. `status = Finalized` is set *before* the call, so even the
guard aside, a re-entrant `finalize` would fail the `status == Open` check.

**Recommendation (accepted residual):** keep the reentrancy guard; only ever point
a season at a vetted market. Documented in code.

### [M-02] No-loss depends on lending-market solvency — *acknowledged (external risk)*

**Description.** "No-loss" holds only if the lending market returns at least the
supplied principal. On a stablecoin de-peg or bad-debt event, `withdraw` could
return **less** than `totalPrincipal`; then `yieldPot` is 0 and `claimPrincipal`
becomes first-come-first-served until the vault is drained, so late claimants would
revert — i.e. the no-loss guarantee fails under market insolvency.

**Impact:** Medium — conditional, depends on an external protocol failing; no
internal bug.

**Hardening applied (pro-rata claim).** The recommended defence-in-depth is now
implemented. `claimPrincipal` (and the new `claimablePrincipal` view) detect
`redeemed < totalPrincipal` and pay each depositor
`principal * redeemed / totalPrincipal`. A shortfall is therefore **shared
fairly across all depositors** rather than the previous first-come-first-served
race, where early claimants withdrew in full and late claimants hit an empty
vault and reverted. Rounding is down per player, so aggregate payouts can never
exceed the recovered amount (dust stays in the vault). Covered by
`test_claimPrincipal_shortfallSharedProRata` and the fuzz test
`testFuzz_shortfallNeverOverPays` (arbitrary deposit split × loss: no over-pay,
no late-claimant lockout).

**Residual (still acknowledged).** This shares the loss fairly; it does not
*prevent* it. The no-loss guarantee still assumes the external market stays
solvent. Continue to use only audited, liquid Celo markets, cap per-season
exposure, and monitor the peg (architecture §13).

---

## Low

### [L-01] Prize Merkle root is trusted to reflect true standings — *acknowledged*

The owner/keeper submits `prizeMerkleRoot` at `finalize` from off-chain standings.
A malicious root cannot pay out **more than the realised yield** — `claimPrize`
enforces `prizeDistributed + amount <= yieldPot` — but it could *misallocate* the
yield among players. Principal is never at risk from this. **Mitigation:** multisig
keeper, publish the standings + tree so anyone can verify the root; consider a
challenge window before claims open.

### [L-02] Privileged owner / keeper — *acknowledged*

The owner creates seasons, selects the lending pool, and finalizes. As with the
other contracts, move ownership to a timelock + multisig before mainnet (§13).

---

## Informational

### [I-01] One active season per token limits throughput — *by design*

`createSeason` rejects a new season for a token while one is un-finalized
(`token busy`). This is deliberate: it keeps the aToken balance unambiguously
attributable to a single season, making `yield = redeemed − totalPrincipal` exact.
Concurrent seasons would need per-season share accounting; out of scope for v1.

### [I-02] `block.timestamp` window comparisons — *by design*

Deposit deadline and season end compare against `block.timestamp`; drift is
negligible at season timescales.

---

## Security properties confirmed

- **No-loss (solvent market)** — principal is tracked per player and isolated from
  yield; `claimPrincipal` always returns the full deposit (tested, incl. zero-yield).
- **Yield cannot be over-distributed** — `claimPrize` is capped at `yieldPot`
  regardless of the Merkle root, and double-claims are blocked (tested).
- **Reentrancy** — all fund paths are `nonReentrant`; `SafeERC20` + `forceApprove`
  used throughout; exact-accounting invariant via one-season-per-token.
- **Integration** — verified against the mock pool (deterministic, incl. yield
  accrual) and via a gated Celo mainnet-fork lifecycle test
  (`HarvestVault.fork.t.sol`, run with `CELO_FORK_RPC` + `AAVE_POOL` + `AAVE_TOKEN`).

## Conclusion

No Critical/High issues. M-01 is a non-exploitable reentrancy shape mitigated by the
guard + access control + trusted integration. M-02 is the inherent "no-loss"
caveat — solvency of the external market — to be managed operationally, with
pro-rata principal as a recommended hardening. An independent external audit
(especially of the lending integration) is required before mainnet.
