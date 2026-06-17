# Security Review — `Treasury`

| | |
|---|---|
| **Contract** | `contracts/src/Treasury.sol` |
| **Type** | Fee-custody vault (holds protocol funds) |
| **Reviewer** | Author self-review (Pashov-style) — *not* an external audit |
| **Review date** | 2026-06-17 |
| **Branch** | `feat/contracts-rules-engine` |
| **Dependencies** | OpenZeppelin v5.1.0 (`SafeERC20`, `ReentrancyGuard`, `Ownable`) |

## Scope & purpose

`Treasury` custodies the rake routed to it by `MatchEscrow` (and, later, the
protocol share of vault yield) and lets governance withdraw it. It is intentionally
a **passive, decoupled vault**: it has no reference to `MatchEscrow`, requires no
privileged caller, and receives fees as ordinary ERC-20 transfers. Per-match revenue
is read off `MatchEscrow`'s `FeeCollected` events; this contract only does custody
and controlled withdrawal.

## Findings summary

| ID | Title | Severity | Status |
|---|---|---|---|
| L-01 | Owner can withdraw all funds | Low | Acknowledged |
| I-01 | Low-level `call` in `withdrawNative` | Informational | By design |
| I-02 | No on-chain cumulative-revenue accounting | Informational | By design |

No Critical/High/Medium findings.

---

## Low

### [L-01] Owner can withdraw all funds — *acknowledged*

`withdraw` / `withdrawAll` / `withdrawNative` are `onlyOwner` and can move the entire
balance anywhere. This is the contract's purpose (governance collecting protocol
revenue), but it makes the owner fully trusted: a compromised owner key drains
accumulated fees. No user stake is ever at risk here — stakes live in `MatchEscrow`
and never transit this contract.

**Mitigation (architecture §13):** set the owner to a timelock + multisig before
mainnet so fee withdrawal is delayed and multi-party.

---

## Informational

### [I-01] Low-level `call` in `withdrawNative` — *by design*

Native CELO is sent with `to.call{value: amount}("")`, the recommended pattern
post-EIP-1884 (over `transfer`/`send`, which forward a fixed 2300 gas). The return
value is checked (`require(ok)`), the function is `onlyOwner` and `nonReentrant`, and
state changes are event-only, so the low-level call introduces no risk. Flagged by
Slither; accepted.

### [I-02] No on-chain cumulative-revenue accounting — *by design*

Because fees arrive as plain transfers (no hook), the contract does not track
lifetime revenue on-chain; current holdings are `balanceOf(token)`. Cumulative
protocol revenue for the public `/stats` page is derived from `FeeCollected` events
via the indexer. Adding push-accounting would require coupling `MatchEscrow` to a
trusted `Treasury` callback, which is intentionally avoided.

---

## Security properties confirmed

- **No reentrancy** — withdrawals are `nonReentrant` and `onlyOwner`; the native
  send checks its return value.
- **No stuck funds** — both ERC-20 (`withdraw`/`withdrawAll`) and native
  (`receive` + `withdrawNative`) can always be recovered by the owner.
- **Decoupling** — no dependency on `MatchEscrow`, so no privileged-caller surface
  and nothing to misconfigure between the two.
- Recipient-zero guarded on every withdrawal path; insufficient-balance reverts via
  `SafeERC20`. Covered by 8 tests.

## Conclusion

No security-relevant defects. The single residual is the trusted-owner assumption
(L-01), mitigated by moving ownership to a timelock + multisig before mainnet. The
contract is minimal, decoupled, and holds only already-earned protocol fees — never
user stakes.
