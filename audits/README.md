# Security reviews

This folder holds an internal, Pashov-style security review for **every** contract
in `contracts/src`. Each report uses the methodology and severity model common to
firms like the [Pashov Audit Group](https://www.pashov.net/): an impact × likelihood
risk matrix, findings graded Critical → Gas, and a resolution status per finding.

> [!IMPORTANT]
> **These are self-conducted reviews by the contract author, not an engagement
> with the Pashov Audit Group or any third party.** They do not replace an
> independent external audit, which remains a hard prerequisite before mainnet
> deployment and MiniPay listing (architecture §13). Treat them as a rigorous
> first pass that documents known risks and the reasoning behind each design.

## Reports

| Contract | Report | Highest open severity |
|---|---|---|
| `AwaleRules` | [AwaleRules.md](AwaleRules.md) | Informational |
| `ReplayVerifier` | [ReplayVerifier.md](ReplayVerifier.md) | Informational |
| `MatchEscrow` | [MatchEscrow.md](MatchEscrow.md) | Low (acknowledged) |
| `Treasury` | [Treasury.md](Treasury.md) | Low (acknowledged) |
| `HarvestVault` | [HarvestVault.md](HarvestVault.md) | Medium (acknowledged: market solvency) |
| `Cosmetics` | [Cosmetics.md](Cosmetics.md) | Low (acknowledged) |

## Severity model

Severity is the product of **impact** (how bad) and **likelihood** (how probable):

| | Likelihood: High | Medium | Low |
|---|---|---|---|
| **Impact: High** | Critical | High | Medium |
| **Impact: Medium** | High | Medium | Low |
| **Impact: Low** | Medium | Low | Low |

- **Critical** — direct, easily triggered loss of funds or protocol takeover.
- **High** — loss of funds or severe protocol damage under realistic conditions.
- **Medium** — limited or conditional loss/damage, or a meaningful invariant break.
- **Low** — minor issues, hard-to-reach edge cases, or defence-in-depth gaps.
- **Informational / Gas** — non-security observations and optimisations.

## Tooling

- `forge test` — 50 unit/fuzz/parity tests across the suite.
- `forge fmt --check` — formatting gate.
- `slither` — static analysis (`contracts/slither.config.json`), run in CI.
- Cross-language differential test — the TypeScript engine replays Solidity-generated
  vectors and must match every intermediate state (`packages/engine`).

All of the above run on every push via `.github/workflows/ci.yml`.
