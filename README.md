# Awalé On-Chain

A real-money, skill-based Awalé (Oware) game built as a [MiniPay](https://www.minipay.to/) mini-app on Celo. Trust-critical state (stakes, settlement, disputes) lives on-chain; real-time gameplay stays off-chain for speed and cost, secured by an optimistic / fraud-proof model.

## Repository layout

| Path | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Full technical architecture (on-chain / off-chain), grounded in the MiniPay developer references. |
| [contracts/](contracts/) | Foundry project: smart contracts and the deterministic Awalé rule engine. |
| [packages/protocol/](packages/protocol/) | Shared primitives: EIP-712 digests, token config, ABIs — one source of truth for server and app. |
| [packages/engine/](packages/engine/) | TypeScript port of the rule engine for the game server, with a Solidity-parity test. |
| [packages/game-server/](packages/game-server/) | Authoritative off-chain server: match orchestration, session-key move verification, ELO matchmaking, settlement client. |
| [packages/indexer/](packages/indexer/) | Reads MatchEscrow events (chunked `eth_getLogs`) and aggregates the public `/stats` metrics. |
| [packages/app/](packages/app/) | MiniPay mini-app (Next.js + viem): zero-click connect, session keys, stablecoin play, `/stats`. |
| [audits/](audits/) | Pashov-style security review per contract (self-conducted; not an external audit). |

## Contracts

Built with [Foundry](https://book.getfoundry.sh/). The trust-critical core is [`AwaleRules`](contracts/src/AwaleRules.sol) — a pure, deterministic implementation of the **Oware Abapa** rules, shared by the off-chain game server and the on-chain `ReplayVerifier`. Given the same start state and ordered moves, every replay reaches byte-identical state.

```bash
cd contracts && forge test                # contract + rule-engine tests
cd packages/engine && npm ci && npm test  # TS engine + Solidity-parity vectors
forge script script/GenVectors.s.sol      # (re)generate parity vectors
```

### Deployment

`script/Deploy.s.sol` deploys `ReplayVerifier → Treasury → MatchEscrow`, allowlists
the network's stablecoins, sets parameters, and hands ownership to governance.
Config is chain-id driven (Celo mainnet `42220`, Celo Sepolia `11142220`, else a
local mock). Copy `contracts/.env.example` to `.env` and fill it in, then:

```bash
forge script script/Deploy.s.sol --rpc-url $CELO_SEPOLIA_RPC --broadcast --verify
```

See **[docs/deployment.md](docs/deployment.md)** for the full Celo Sepolia deploy →
off-chain config → physical-device MiniPay test runbook and the pre-listing checklist.

## Engine parity

The off-chain engine ([packages/engine](packages/engine/src/awale.ts)) is a line-for-line port of the Solidity one. A differential test replays Solidity-generated vectors through the TypeScript engine and asserts a rolling hash over **every** intermediate state matches — guaranteeing the off-chain server and the on-chain `ReplayVerifier` can never disagree.

## Game server

[packages/game-server](packages/game-server/) is the authoritative off-chain core. It is
authoritative over *sequencing* but never over *moves*: it holds no session keys, so each
move must carry a signature by the mover's per-match session key over the **exact on-chain
move digest**, which the server verifies before applying it through the shared engine. A
parity test pins the server's EIP-712 digests against `ReplayVerifier.moveDigest` /
`MatchEscrow.resultDigest`, so server-collected signatures are guaranteed to verify on-chain.

```bash
cd packages/game-server && npm ci && npm test
```

## Mini-app

[packages/app](packages/app/) is the MiniPay mini-app (Next.js App Router + viem). It
auto-connects from the injected wallet when `isMiniPay` (no Connect button), never
requests wallet message signing, and signs moves with per-match **session keys** whose
signatures are pinned to the on-chain digests (`src/lib/session.test.ts`). Designed at
360×640 with the MiniPay copy lexicon (Deposit / Network fee / Stablecoin) and a public
`/stats` page. The `/play` route is a self-contained demo game against the engine.

```bash
cd packages/app && npm ci && npm test && npm run build   # or: npm run dev
```

## Security

Each contract has an internal [Pashov-style review](audits/). These are **not** a substitute for an independent external audit, which is required before mainnet. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the test suites, `forge fmt`, Slither static analysis, and the cross-language parity check on every push.

### Status

- [x] `AwaleRules` — deterministic rule engine (sowing, capture, grand-slam, feeding obligation, termination) + tests
- [x] `ReplayVerifier` — on-chain dispute resolution over EIP-712-signed transcripts + tests
- [x] `MatchEscrow` — stake custody, session keys, signed/optimistic/replay settlement, audit hardening + tests
- [x] `Treasury` — protocol-fee custody with governed withdrawals + tests
- [x] TypeScript engine + Solidity parity vectors
- [x] CI (Foundry tests, fmt, Slither, parity) + per-contract security reviews
- [x] Deployment script (chain-id config, allowlist, ownership handover) + test
- [x] `HarvestVault` — no-loss league (lending supply, yield harvest, Merkle prizes) + mock & fork tests
- [x] `Cosmetics` — ERC-1155 board/seed skins with ERC-2981 royalties + tests
- [x] Game server core (match orchestration, session-key verification, ELO, settlement client) + EIP-712 parity
- [x] Shared `@awale/protocol` package (EIP-712 digests, token config, ABIs) — single source of truth
- [x] Mini-app (Next.js + viem): zero-click connect, session keys, board, `/stats` — builds at ~135 kB First Load JS
- [x] Indexer (chunked `eth_getLogs`) + `/stats` wired to settlement events
- [x] Server glue: on-chain `MatchJoined` listener → hub, keeper (`finalize`/`voidExpired`)
- [x] Server persistence (live match store + leaderboard/ratings; Redis & Postgres adapters)
- [x] Phone-first name service (ODIS, cached) · Self proof-of-personhood gating (anti-sybil)
- [x] Mini-app lobby wired to contracts (create/join with `feeCurrency`, session keys)
- [ ] Testnet deploy (Celo Sepolia) + Celoscan verification + device test (physical, no emulators)
- [ ] Integration wiring (Redis/Postgres/ODIS/Self adapters to real services) — needs a live chain
- [ ] Mini-app front end (Next.js + viem)
- [ ] Game server (Node/TypeScript)

> **Audit status:** contracts are tested and self-reviewed, **not externally audited**. An independent audit is a hard prerequisite before mainnet and MiniPay listing.
