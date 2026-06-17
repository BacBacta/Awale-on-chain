# Awalé On-Chain

A real-money, skill-based Awalé (Oware) game built as a [MiniPay](https://www.minipay.to/) mini-app on Celo. Trust-critical state (stakes, settlement, disputes) lives on-chain; real-time gameplay stays off-chain for speed and cost, secured by an optimistic / fraud-proof model.

## Repository layout

| Path | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Full technical architecture (on-chain / off-chain), grounded in the MiniPay developer references. |
| [contracts/](contracts/) | Foundry project: smart contracts and the deterministic Awalé rule engine. |
| [packages/engine/](packages/engine/) | TypeScript port of the rule engine for the game server, with a Solidity-parity test. |
| [audits/](audits/) | Pashov-style security review per contract (self-conducted; not an external audit). |

## Contracts

Built with [Foundry](https://book.getfoundry.sh/). The trust-critical core is [`AwaleRules`](contracts/src/AwaleRules.sol) — a pure, deterministic implementation of the **Oware Abapa** rules, shared by the off-chain game server and the on-chain `ReplayVerifier`. Given the same start state and ordered moves, every replay reaches byte-identical state.

```bash
cd contracts && forge test                # contract + rule-engine tests
cd packages/engine && npm ci && npm test  # TS engine + Solidity-parity vectors
forge script script/GenVectors.s.sol      # (re)generate parity vectors
```

## Engine parity

The off-chain engine ([packages/engine](packages/engine/src/awale.ts)) is a line-for-line port of the Solidity one. A differential test replays Solidity-generated vectors through the TypeScript engine and asserts a rolling hash over **every** intermediate state matches — guaranteeing the off-chain server and the on-chain `ReplayVerifier` can never disagree.

## Security

Each contract has an internal [Pashov-style review](audits/). These are **not** a substitute for an independent external audit, which is required before mainnet. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the test suites, `forge fmt`, Slither static analysis, and the cross-language parity check on every push.

### Status

- [x] `AwaleRules` — deterministic rule engine (sowing, capture, grand-slam, feeding obligation, termination) + tests
- [x] `ReplayVerifier` — on-chain dispute resolution over EIP-712-signed transcripts + tests
- [x] `MatchEscrow` — stake custody, session keys, signed/optimistic/replay settlement, audit hardening + tests
- [x] `Treasury` — protocol-fee custody with governed withdrawals + tests
- [x] TypeScript engine + Solidity parity vectors
- [x] CI (Foundry tests, fmt, Slither, parity) + per-contract security reviews
- [ ] `HarvestVault`, `Cosmetics`
- [ ] Mini-app front end (Next.js + viem)
- [ ] Game server (Node/TypeScript)

> **Audit status:** contracts are tested and self-reviewed, **not externally audited**. An independent audit is a hard prerequisite before mainnet and MiniPay listing.
