# Awalé On-Chain

A real-money, skill-based Awalé (Oware) game built as a [MiniPay](https://www.minipay.to/) mini-app on Celo. Trust-critical state (stakes, settlement, disputes) lives on-chain; real-time gameplay stays off-chain for speed and cost, secured by an optimistic / fraud-proof model.

## Repository layout

| Path | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Full technical architecture (on-chain / off-chain), grounded in the MiniPay developer references. |
| [contracts/](contracts/) | Foundry project: smart contracts and the deterministic Awalé rule engine. |

## Contracts

Built with [Foundry](https://book.getfoundry.sh/). The trust-critical core is [`AwaleRules`](contracts/src/AwaleRules.sol) — a pure, deterministic implementation of the **Oware Abapa** rules, shared by the off-chain game server and the on-chain `ReplayVerifier`. Given the same start state and ordered moves, every replay reaches byte-identical state.

```bash
cd contracts
forge test          # run the rule-engine test suite
```

### Status

- [x] `AwaleRules` — deterministic rule engine (sowing, capture, grand-slam, feeding obligation, termination) + tests
- [x] `ReplayVerifier` — on-chain dispute resolution over EIP-712-signed transcripts + tests
- [ ] `MatchEscrow` — stake locking + session-key registration + optimistic settlement
- [ ] `HarvestVault`, `Treasury`, `Cosmetics`
- [ ] Mini-app front end (Next.js + viem)
- [ ] Game server (Node/TypeScript)
