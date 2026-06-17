# Awalé On-Chain — Technical Architecture (on-chain / off-chain)

> Grounded in the official MiniPay / Celo developer references (celopedia-skills).
> Working draft — June 2026.

## 1. Scope and source references

This document refines the earlier architecture into a MiniPay-accurate design. Every platform-specific decision below is grounded in the Celo/MiniPay developer references (celopedia-skills): the MiniPay guide, requirements, templates, scaffold, live-apps snapshot, ODIS/SocialConnect, the SDK reference, the builder guide, dev-templates, and the two docs maps. The full URLs are in the [Sources](#sources) section.

The single most important consequence of reading those references: **MiniPay does not support message signing** (`personal_sign`, `eth_signTypedData`). The fairness model from the previous draft, which relied on players signing each move with their wallet, is therefore replaced by a **session-key model authorized by an on-chain transaction** (Section 7). Other constraints (CIP-64 fee abstraction, legacy-only transactions, phone-first identity, USDm/USDC/USDT only, 2 MB / 360×640) also shape the design.

## 2. MiniPay platform constraints that shape the design

| Constraint | Design consequence |
|---|---|
| No message signing (`personal_sign` / `eth_signTypedData` unsupported) | Cannot sign moves with the wallet. Use session keys registered via an on-chain transaction (Section 7). |
| CIP-64 fee abstraction; legacy transactions only | Pay the network fee in stablecoin via the `feeCurrency` field; never set `maxFeePerGas` / `maxPriorityFeePerGas`. |
| Tokens: USDm, USDC, USDT only; never show CELO | Stakes, pots and payouts are in stablecoins; the engine handles 18-dec (USDm) vs 6-dec (USDC/USDT). |
| Phone-first identity; never show raw `0x…` addresses | Resolve display names via ODIS → FederatedAttestations (MiniPay issuer); `0x` only as a faint secondary hint. |
| Zero-click connect inside MiniPay | Auto-connect from `window.ethereum` when `isMiniPay === true`; no "Connect Wallet" button. |
| 2 MB bundle, 360×640, SVG/WebP, PageSpeed 90+ | Lightweight single-page web app; the heavy real-time logic lives on the server, not the client. |
| Copy rules: Network fee / Deposit / Withdraw / Stablecoin | No "gas / onramp / crypto" wording anywhere a user can read. |
| Audited, Celoscan-verified contracts; 24h critical-fix SLA; public stats page | Contracts verified and audited before listing; an analytics page is part of submission. |

## 3. High-level architecture

Only trust-critical state goes on-chain; real-time gameplay stays off-chain for speed and cost. Awalé is fully deterministic (no hidden information, no chance), which lets the normal path be cheap (settle a result) and the rules be re-executed on-chain only on dispute (an optimistic / fraud-proof model).

| Layer | Runs where | Responsibility |
|---|---|---|
| Mini-app client | MiniPay WebView | Next.js + viem; zero-click connect; renders the board; signs moves with a per-match session key; sends transactions (join, settle, claim) through `window.ethereum` with `feeCurrency`. |
| Game server | Off-chain (cloud) | Matchmaking (ELO), authoritative real-time rules, move sequencing, latency/disconnect handling, anti-cheat; assembles the signed transcript and the final result. |
| Smart contracts | Celo L2 (chainId 42220) | MatchEscrow, ReplayVerifier, HarvestVault, Treasury, Cosmetics; integrate fee currencies, randomness and identity. |
| Identity services | ODIS + on-chain | Phone→address display (ODIS PnP + FederatedAttestations); Self (ZK) proof of personhood for anti-sybil gating. |
| Keeper / automation | Off-chain trigger | Settlement timeouts, season finalization, vault yield harvesting. |
| Indexer + stats | Off-chain read | Match history, leaderboards, verifiable replays, and the required public stats page (The Graph / Envio / Goldsky; paginate `eth_getLogs` at ≤ 50k blocks). |

## 4. Mini-app front end

Stack per the MiniPay references: a standalone Next.js app with viem v2, `@celo/abis` and `@celo/identity` — no wagmi/connector libraries required, MiniPay injects `window.ethereum` directly. Scaffold via `npx @celo/celo-composer@latest create -t minipay`, or a plain `create-next-app` for a single-app repo. Test on a physical device over ngrok (no emulators).

### 4.1 Zero-click connect

```ts
const isMiniPay = window.ethereum?.isMiniPay === true;
const wallet = createWalletClient({ chain: celo, transport: custom(window.ethereum) });
const [address] = await wallet.getAddresses(); // no Connect button
```

### 4.2 Tokens, decimals and preferred stablecoin

Read balances with the **token** addresses; pay the network fee with the **feeCurrency** address (USDC/USDT need their adapter, not the token, or the transaction fails). Adapt to the user's highest-balance stablecoin, and on zero balance redirect to the Deposit deeplink rather than showing an error.

| Token | Decimals | Token address (balances/transfers) | feeCurrency address (network fee) |
|---|---|---|---|
| USDm | 18 | `0x765DE816845861e75A25fCA122bb6898B8B1282a` | `0x765DE816845861e75A25fCA122bb6898B8B1282a` (same) |
| USDC | 6 | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` | `0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B` (adapter) |
| USDT | 6 | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | `0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72` (adapter) |

Allowlist governed by the `FeeCurrencyDirectory` at `0x15F344b9E6c3Cb6F0376A36A64928b13F62C6276`.

### 4.3 Identity, deeplinks and custom methods

- **Display names**: resolve the counterpart's phone number via ODIS + FederatedAttestations (Section 5); never show a raw `0x…` as the primary identifier.
- **Invite / duel a friend**: use MiniPay's Request Contact custom method and the Invite Friends deeplink to seed head-to-head matches from the user's contacts.
- **Low balance** → Add Cash deeplink (`https://link.minipay.xyz/add_cash?tokens=USDm,USDC,USDT`); **payout** → Transaction Receipt deeplink (`https://link.minipay.xyz/receipt?tx=…&celebrate`) for the win celebration.

### 4.4 Performance & submission

Design and verify at 360×640; SVG/WebP assets; keep the bundle ≤ 2 MB; target PageSpeed 90+. Use the copy lexicon (Network fee, Deposit, Withdraw, Stablecoin). Ship a public `/stats` page (DAU, MAU, D1/D7/D30 retention, tx volume per stablecoin, network fees paid, protocol revenue, failed-tx rate) — it is part of the readiness review.

## 5. Identity and anti-sybil

Two distinct needs, two mechanisms:

- **Display (phone-first)** — resolve E.164 numbers to addresses with ODIS PnP + FederatedAttestations, querying the MiniPay trusted issuer `0x7888612486844Bb9BE598668081c59A9f7367FBc`. Mainnet PnP needs non-zero quota: `increaseAllowance` on the stable token, then `OdisPayments.payInCUSD`. Do this on a **backend** signer (keys never in the WebView). FederatedAttestations registry: `0x0aD5b1d0C25ecF6266Dd951403723B2687d6aff2`.
- **Anti-sybil / one-human-per-account** — gate ranked and cash play with **Self** (Celo's ZK proof-of-personhood). This blocks the multi-accounting and win-trading that plague real-money skill games, without exposing personal data. Combine with off-chain ELO and behavioural detection.

## 6. On-chain contracts

| Contract | Purpose |
|---|---|
| **MatchEscrow** | `createMatch` / `joinMatch` lock both stakes (in the chosen stablecoin) and register each player's per-match session public key; `settle()` pays the winner and routes the rake to Treasury; abandon/timeout forfeits to the present player. Emits `FeeCollected` for the stats page. |
| **ReplayVerifier** | On dispute, re-executes the deterministic Awalé rules from the signed transcript and verifies each move's signature against the registered session key; pays the honest player and slashes the cheater. Cheap because the rule engine is tiny. |
| **HarvestVault** | No-loss league: season deposits supply a Celo lending market (e.g. Aave/Moola) to accrue yield; principal is always returned; prizes are claimed via a Merkle proof over the final standings. |
| **Treasury** | Collects rake and the yield share; fully on-chain auditable; basis for the protocol-revenue metric. |
| **Cosmetics** (ERC-1155 + ERC-2981) | Owned, tradeable board/seed skins with on-chain royalties on resale. |

Solidity on Celo (EVM, chainId 42220), OpenZeppelin libraries, developed with Foundry or Hardhat, tested against a mainnet fork, deployed to Celo Sepolia (chainId 11142220) then mainnet, and verified on Celoscan. Randomness (first move, tie-breaks, matchmaking seed) via Chainlink VRF on Celo or commit-reveal — minimal, since Awalé itself has no chance.

## 7. The fairness model without message signing

MiniPay forbids wallet message signing, so players cannot sign each move with their wallet. The design instead uses a **per-match session key authorized by the join transaction** — the one thing MiniPay does allow is sending transactions.

1. **Session key creation** — when entering a match, the mini-app generates an ephemeral keypair locally (not the wallet key).
2. **On-chain authorization** — the player calls `MatchEscrow.joinMatch(matchId, sessionPubKey)`: a single transaction that both locks the stake (fee paid in stablecoin via `feeCurrency`) and binds the session key to that player for that match. No message signing is ever requested from the wallet.
3. **Move authentication** — during play, each client signs its own moves with its session key (an in-app operation, not a wallet prompt). The server sequences moves and broadcasts state; it cannot forge or alter moves because it does not hold the session keys.
4. **Optimistic settlement** — at game end the server submits to MatchEscrow only the winner and the hash of the signed transcript, opening a short challenge window.
5. **Fraud proof** — if either side disagrees, they submit the signed transcript to ReplayVerifier, which replays the rules on-chain and checks every signature against the registered session keys. The honest player is paid; the cheater is slashed. Because cheating is always provable and punished, the happy path stays cheap and disputes are rare.

> **Risk note:** a session key lives in the WebView and is scoped to a single match, so its worst-case compromise is bounded by that one stake — an acceptable trade for a constraint-compliant, trust-minimized design. The same session-key signatures make **state channels** viable for high-volume cash play (open with both stakes, exchange signed states off-chain, settle on close, dispute via the same replay).

## 8. Cash-match sequence

1. Player picks a table; the mini-app checks the preferred stablecoin; if zero balance, redirect to the Add Cash deeplink.
2. `joinMatch(matchId, sessionPubKey)` locks the stake and registers the session key (legacy tx, `feeCurrency` = the user's stablecoin).
3. The server pairs two funded players of similar ELO (gated by Self proof of personhood), opens a WebSocket match, assigns the first move from committed randomness.
4. Players exchange session-key-signed moves; the server validates each against Awalé rules and sequences them.
5. On end, the server submits `settle(winner, scoreHash, transcriptHash)`; a challenge window opens (e.g. 60–120s).
6. If unchallenged, MatchEscrow pays the winner and sends the rake to Treasury; if challenged, ReplayVerifier decides on-chain.
7. Winnings auto-split: a configurable share to the wallet, the rest into the savings vault; show the Transaction Receipt deeplink with celebration.

## 9. Harvest League flow (no-loss)

- Deposit into HarvestVault → the vault supplies pooled stablecoin to a Celo lending market and accrues yield over the season.
- Daily ranked games update an off-chain leaderboard; a Merkle root of the standings is committed on-chain periodically for verifiability.
- At season end a keeper finalizes the ranking, the vault harvests yield, and prizes + principal are claimable via Merkle proofs — principal returned in full (no-loss).

## 10. Gas, fees and transactions (CIP-64)

- Every transaction sets `feeCurrency` to the user's stablecoin so the network fee is paid in USDm/USDC/USDT — never CELO in the UI. USDC/USDT must use their **adapter** address in `feeCurrency`.
- **Legacy transactions only** — do not set EIP-1559 fields. Estimate the fee with `feeCurrency` passed to `estimateGas` and `eth_gasPrice` (fee-currency param).
- Only **viem** exposes native `feeCurrency` support — it is the mandated client SDK here; ethers/web3 do not.

## 11. Scaling and cost

Celo L2 gives ~1-second blocks and ~$0.0005 fees, but at 1,000,000 matches/day naive settlement is heavy. Levers:

- **Batched settlement** — settle many finished matches in one transaction via a Merkle batch (MiniPay's smart-contract guide supports call batching), amortizing gas across thousands of games.
- **State channels** for high-volume cash play, reducing on-chain footprint to channel open/close.
- **Indexer pagination** — Celo RPCs reject `eth_getLogs` spans > ~50,000 blocks; the indexer must chunk requests.

## 12. Off-chain infrastructure

- **Game server**: Node/TypeScript, WebSocket (e.g. Socket.IO), Redis for live match state, Postgres for history/leaderboard; a server-side viem client and an `@celo/identity` ODIS signer (keys server-side only).
- **Keepers**: Gelato or Chainlink Automation for settlement timeouts and season finalization.
- **Indexing & stats**: The Graph / Envio / Goldsky feed both verifiable replays and the public `/stats` page required for listing.

## 13. Security

- Reentrancy guards on all fund paths; escrow timeouts so a disconnect/abandon forfeits to the opponent rather than locking funds.
- Upgradeable contracts behind a proxy with a timelock and multisig; independent audit before mainnet; all contracts verified on Celoscan (a submission requirement).
- Yield risk: only audited, liquid Celo lending markets; cap vault exposure; monitor for de-peg.
- Anti-collusion: randomized matchmaking (no self-pairing in cash mode), Self personhood gating, win-trading detection, per-account rate limits.
- Session keys scoped per match; never reuse across matches; bounded worst-case loss.

## 14. Build, test, deploy, submit

1. **Scaffold**: `npx @celo/celo-composer@latest create -t minipay` (or plain Next.js). Install: `npm install viem@2 @celo/abis @celo/identity`.
2. **Contracts**: Foundry/Hardhat, Solidity 0.8.x, fork-test against `https://forno.celo.org`; deploy to Celo Sepolia then mainnet; verify on Celoscan (Etherscan V2 key).
3. **Device testing**: expose the dev server with ngrok and load it via MiniPay Developer Settings on a physical Android/iOS device (no emulators).
4. **Pre-listing**: satisfy the MiniPay requirements checklist — zero-click connect, no message signing, no raw addresses, stablecoin-only copy, 360×640, SVG/WebP, PageSpeed, audited+verified contracts with sample tx hashes, in-app support, ToS/Privacy, public stats page, 24h SLA.
5. **Submit** the intake form at `minipay.to/mini-apps`; after the first call, complete the readiness form.

## Appendix — reference addresses (Celo mainnet)

| Role | Address |
|---|---|
| USDm (cUSD) token + feeCurrency | `0x765DE816845861e75A25fCA122bb6898B8B1282a` |
| USDC token | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` |
| USDC feeCurrency adapter | `0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B` |
| USDT token | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` |
| USDT feeCurrency adapter | `0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72` |
| FeeCurrencyDirectory | `0x15F344b9E6c3Cb6F0376A36A64928b13F62C6276` |
| FederatedAttestations | `0x0aD5b1d0C25ecF6266Dd951403723B2687d6aff2` |
| OdisPayments | `0xAE6B29f31B96e61DdDc792f45fDa4e4F0356D0CB` |
| MiniPay ODIS trusted issuer | `0x7888612486844Bb9BE598668081c59A9f7367FBc` |
| Celo mainnet / Sepolia chainId | `42220` / `11142220` |

## Sources

- [minipay-guide](https://github.com/celo-org/celopedia-skills/blob/main/skills/celopedia-skill/references/minipay-guide.md)
- [minipay-templates](https://github.com/celo-org/celopedia-skills/blob/main/skills/celopedia-skill/references/minipay-templates.md)
- [minipay-scaffold-from-scratch](https://github.com/celo-org/celopedia-skills/blob/main/skills/celopedia-skill/references/minipay-scaffold-from-scratch.md)
- [odis-socialconnect](https://github.com/celo-org/celopedia-skills/blob/main/skills/celopedia-skill/references/odis-socialconnect.md)
- [minipay-live-apps](https://github.com/celo-org/celopedia-skills/blob/main/skills/celopedia-skill/references/minipay-live-apps.md)
- [minipay-requirements](https://github.com/celo-org/celopedia-skills/blob/main/skills/celopedia-skill/references/minipay-requirements.md)
- [minipay-docs-map](https://github.com/celo-org/celopedia-skills/blob/main/skills/celopedia-skill/references/minipay-docs-map.md)
- [docs-map](https://github.com/celo-org/celopedia-skills/blob/main/skills/celopedia-skill/references/docs-map.md)
- [builder-guide](https://github.com/celo-org/celopedia-skills/blob/main/skills/celopedia-skill/references/builder-guide.md)
- [dev-templates](https://github.com/celo-org/celopedia-skills/blob/main/skills/celopedia-skill/references/dev-templates.md)
- [sdk-reference](https://github.com/celo-org/celopedia-skills/blob/main/skills/celopedia-skill/references/sdk-reference.md)
