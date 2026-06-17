# Security Review — `Cosmetics`

| | |
|---|---|
| **Contract** | `contracts/src/Cosmetics.sol` |
| **Type** | ERC-1155 + ERC-2981 (cosmetic NFTs, holds no user funds beyond in-flight sale) |
| **Reviewer** | Author self-review (Pashov-style) — *not* an external audit |
| **Review date** | 2026-06-17 |
| **Branch** | `feat/contracts-rules-engine` |
| **Dependencies** | OpenZeppelin v5.1.0 (`ERC1155`, `ERC2981`, `SafeERC20`, `ReentrancyGuard`, `Ownable`) |

## Scope & purpose

`Cosmetics` mints tradeable board/seed skins. Primary sales are paid in a stablecoin
sent directly to the Treasury; the contract holds no balances between calls.
Secondary-sale royalties are advertised via ERC-2981. It is low-risk: no escrow, no
yield, no settlement.

## Findings summary

| ID | Title | Severity | Status |
|---|---|---|---|
| L-01 | ERC-2981 royalties are advisory, not enforced | Low | Acknowledged (standard limitation) |
| L-02 | Privileged owner | Low | Acknowledged |
| L-03 | Fee-on-transfer sale currency under-pays the Treasury | Low | Acknowledged |
| I-01 | `ownerMint` / unlimited `maxSupply` are unbounded by design | Informational | By design |

No Critical/High/Medium findings.

---

## Low

### [L-01] ERC-2981 royalties are advisory — *acknowledged*

`royaltyInfo` only *advertises* a royalty; nothing on-chain forces a marketplace to
honour it on resale. This is inherent to ERC-2981 and not a contract defect.
Royalty income should be treated as best-effort. Marketplaces that enforce
royalties (or an allowlist transfer hook) would be needed for hard enforcement —
out of scope for v1.

### [L-02] Privileged owner — *acknowledged*

The owner can create items, set prices, mint freely (`ownerMint`), and change the
sale currency, treasury, and royalty config. No user funds are custodied, so the
worst case is over-minting cosmetics or redirecting *future* primary-sale proceeds.
Move ownership to a timelock + multisig before mainnet (architecture §13).

### [L-03] Fee-on-transfer sale currency under-pays the Treasury — *acknowledged*

`buy` pulls `price * amount` of `currency` to the Treasury. A fee-on-transfer
currency would deliver less than `cost`. Mitigated operationally: the owner sets
`currency` to a standard stablecoin (USDm/USDC/USDT). The buyer is charged exactly
`cost`, and minting is independent of the received amount, so no accounting breaks —
only the Treasury would net slightly less. Documented.

---

## Informational

### [I-01] `ownerMint` and unlimited supply are by design

`maxSupply == 0` means unlimited, and `ownerMint` can mint without payment (for
promos/airdrops), both capped only by `maxSupply` when set. Intentional; a fixed
cap can be set per item at creation when scarcity is desired.

---

## Security properties confirmed

- **Reentrancy** — `buy` is `nonReentrant`; supply is incremented (effects) before
  the `safeTransferFrom` and `_mint` (which can call the ERC-1155 receiver hook).
- **Supply cap** — `minted + amount <= maxSupply` enforced on both `buy` and
  `ownerMint` when a cap is set.
- **Interfaces** — `supportsInterface` correctly composes ERC-1155 + ERC-2981 +
  ERC-165 (tested).
- **Royalties** — default and per-token royalty resolution tested via `royaltyInfo`.
- Sale proceeds always go to the current `treasury`; access control on all admin
  paths tested.

## Conclusion

No Critical/High/Medium issues. The residuals are the standard ERC-2981
enforcement caveat and the trusted-owner assumption, both acknowledged with
pre-mainnet mitigations. The contract is a straightforward, guarded ERC-1155
storefront that custodies no user funds.
