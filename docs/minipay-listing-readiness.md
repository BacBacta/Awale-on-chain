# MiniPay listing readiness — checklist & status

**Date:** 2026-06-23 · Target: list Awalé as a MiniPay mini-app, then open real-money on mainnet.

Status legend: ✅ done · 🟡 partial · ⬜ missing · 🔒 needs legal/ops (not code).

## A. MiniPay technical requirements (from celopedia minipay-requirements)
| # | Requirement | Status | Notes |
|---|---|---|---|
| 1 | Zero-click wallet connect (no "Connect Wallet" button) | ✅ | `connect()` auto-runs on load via injected provider |
| 2 | No `personal_sign` / `eth_signTypedData` | ✅ | Session keys sign moves off-chain; no wallet message signing |
| 3 | No raw `0x…` addresses as primary identifier | ✅ | `friendlyName()` / phone-first display |
| 4 | Stablecoin-only (USDT/USDC/USDm); never show CELO | ✅ | `stakeTokens()`; gas via CIP-64 `feeCurrency` |
| 5 | Adaptive to highest-balance stablecoin | ✅ | `preferredIndex()` in MatchActions |
| 6 | UI copy: "Network fee/Deposit/Withdraw/Stablecoin" | 🟡 | mostly compliant; sweep copy before submit |
| 7 | Tested at 360×640 | ✅ | `.frame` max-width 384, designed for it |
| 8 | SVG/WebP images only | ✅ | crafted SVG Icon set; seed/board assets |
| 9 | PageSpeed score documented | ⬜ | run Lighthouse on prod, record |
| 10 | Full URL/subdomain/origin manifest | 🟡 | `awale-on-chain.vercel.app` (use a custom domain for listing) |
| 11 | All contracts verified on Celoscan | ✅ | MatchEscrow/Tournament/etc. verified |
| 12 | Sample tx hashes for every user-facing method | 🟡 | have create/join/finalize/club-tournament hashes; compile a list |
| 13 | Insufficient balance → deposit deeplink | ✅ | Add Cash deeplink |
| 14 | In-app support link (Telegram/WhatsApp/email/web) | ⬜ | **add** (this PR) |
| 15 | 24h SLA commitment | 🔒 | ops |
| 16 | App name + logo distinct from MiniPay | ✅ | "Awalé" brand |
| 17 | ToS + Privacy links in-app | ⬜ | **add** (this PR — scaffold; copy needs counsel) |
| 18 | Public stats page (DAU/MAU/retention/fees/failed-tx) | 🟡 | `/stats` is player stats; add a protocol metrics view |
| 19 | AI support agent on Telegram (recommended) | ⬜ | optional |

## B. Real-money compliance (skill-game-for-stablecoin)
MiniPay's own terms don't ban real-money/skill gaming; the binding rule is **"comply with applicable local law"** + **18+**. The burden is on us.
| Item | Status | Notes |
|---|---|---|
| **18+ age gate** before cash play | ⬜ | **add** (this PR) — one-time acknowledgment |
| **Eligibility / jurisdiction acknowledgment** | ⬜ | **add** (this PR) — user attests they may legally play for money |
| **Geo-fencing** of prohibited jurisdictions | 🟡 | client acknowledgment now; **real geo-fence needs edge/geo-IP** (ops) |
| **Skill-game positioning** (Awalé = pure skill) | ✅ | true; surface it in copy/ToS |
| **Proof-of-personhood / anti-sybil** | 🟡 | `PersonhoodVerify` (Self) scaffolded; enable + gate cash on it |
| **Responsible-play** copy + self-exclusion | ⬜ | add basic copy + a stake limit option (later) |
| KYC (if a jurisdiction requires) | 🔒 | legal-driven; Self covers personhood, not identity |

## C. Security / contracts (pre-mainnet)
| Item | Status | Notes |
|---|---|---|
| AI multi-agent audit | ✅ | 12 agents; 2 MatchEscrow findings **fixed** + redeployed |
| Independent human review | ⬜ | **strongly recommended** before mainnet real money |
| Bug bounty | ⬜ | recommended at launch |
| Mainnet deploy (real stablecoins, no faucet/mocks) | ⬜ | currently all on Celo Sepolia testnet |
| Timelock + multisig owner | ⬜ | owner is an EOA (deployer) on testnet; use timelock+multisig on mainnet |

## What this PR implements (the cheap, high-value wins)
1. **18+ / eligibility gate** before any cash stake or tournament join (one-time, persisted), with a jurisdiction attestation.
2. **Legal & support**: in-app links to `/legal/terms`, `/legal/privacy`, and a support contact — scaffolded pages with the real-money disclaimers (⚠️ **copy must be reviewed by counsel** before mainnet).
3. Skill-game + responsible-play framing surfaced at the gate.

## Deferred (ops / legal / mainnet milestone)
Real geo-IP fencing · counsel-reviewed ToS/Privacy · mainnet deploy + timelock/multisig · independent audit + bug bounty · PageSpeed record · custom domain · 24h SLA + Telegram support.
