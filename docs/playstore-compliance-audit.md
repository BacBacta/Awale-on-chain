# Google Play compliance audit

**Date:** 2026-08-13
**Scope:** shipping `packages/app` (and the game server it depends on) as an app on the
Google Play Store.
**Verdict:** ❌ **Not shippable to Google Play in its current form.** Two of the blockers
are structural — they are properties of the product, not of the build config.

---

## 0. Summary

| # | Area | Severity | State |
|---|---|---|---|
| 1 | No Android artifact exists at all | 🔴 Blocker | No `AndroidManifest.xml`, no Gradle, no TWA/Capacitor project anywhere in the repo. Play accepts an AAB, not a URL. |
| 2 | Real-money wagering with a rake | 🔴 Blocker | Play's Real-Money Gambling policy requires a **gambling licence per country of distribution**. We have none, and the app category (PvP stake + 8% rake) is not one of the eligible RMG verticals. |
| 3 | Crypto stakes + tokenized assets | 🔴 Blocker | Stablecoin stakes, ERC-1155 cosmetics sold for stablecoin, ERC-2981 resale royalties. Collides with the Payments policy (digital goods → Play Billing) and the tokenized-assets rules. |
| 4 | No age verification | 🔴 Blocker | ToS says 18+; nothing enforces it. The Self check is **optional, prize-only, and mock-by-default**. |
| 5 | No geo-blocking | 🔴 Blocker | Zero country detection in app or server. Required by Play *and* by law in most jurisdictions. |
| 6 | Data Safety / privacy mismatch | 🟠 High | The privacy policy asserts things the stack contradicts (IPs, device identifiers). A wrong Data Safety form is itself a policy violation. |
| 7 | No account deletion path | 🟠 High | Play requires in-app deletion **and** a public web URL for any app with accounts. Off-chain profiles/ratings/push subs exist and are deletable. |
| 8 | Content rating will land at AO / 18+ | 🟠 High | IARC gambling declarations force Adults Only in several territories, which is itself heavily restricted. |
| 9 | Target API 36 deadline | 🟠 High | New apps must target Android 16 (API 36) from **31 Aug 2026** — 18 days out. |
| 10 | Store listing copy | 🟡 Medium | "Play Awalé and win real money" is in the manifest, `<title>`/meta, and the hero. It is a self-report of an RMG app. |
| 11 | Console account prerequisites | 🟡 Medium | Personal accounts need 12 testers × 14 days closed testing; EU trader declaration; developer verification. |
| 12 | Pre-mainnet blockers still open | 🟠 High | `docs/mainnet-checklist.md` still lists an unfixed fund-loss attack and "no external audit". Consumer-protection exposure on top of Play policy. |

---

## 1. There is no Android app to submit

The product is a Next.js PWA designed as a **MiniPay mini-app** — that is the distribution
channel it was architected for (`docs/architecture.md`, zero-click injected-wallet connect,
360×640 layout, MiniPay copy lexicon). There is:

- no `AndroidManifest.xml`, no `build.gradle`, no `capacitor.config.*`, no Bubblewrap
  `twa-manifest.json` — verified by a repo-wide search;
- a `public/manifest.webmanifest` and `public/sw.js`, i.e. PWA assets only.

Google Play takes an **AAB**. Getting there means one of:

| Path | What it is | Consequence |
|---|---|---|
| **TWA** (Bubblewrap) | Chrome Custom Tab in fullscreen, driven by the same web app; requires Digital Asset Links on the domain | Cheapest. But Google explicitly evaluates the *content served*, so every policy issue below still applies unchanged. |
| **Capacitor / WebView wrapper** | Native shell + WebView | Same policy surface, plus a WebView that must not be used to circumvent Play Billing. |
| **Native rewrite** | Real Android client | Months of work; does not change the policy verdict either. |

The manifest also fails Play's icon expectations for a TWA: a **single SVG** icon
(`/icon.svg`, `"sizes": "any"`). Bubblewrap needs a raster ≥512×512 PNG, and Play needs a
512×512 icon plus a 1024×500 feature graphic. `public/exported-logo/` and `logo.png` exist
and can supply these.

**Also:** whichever wrapper is chosen, from **31 August 2026** new apps must target
**Android 16 / API 36**. That is 18 days from this audit. An extension is available to
1 November 2026, but it must be requested.

---

## 2. 🔴 Blocker — Real-Money Gambling, Games, and Contests

This is the one that ends the conversation for the current product.

Play's [RMG policy](https://support.google.com/googleplay/android-developer/answer/9877032)
allows real-money apps **only** in an eligible-country list, **only** for licensed
verticals (online casino, sports betting, horse racing, lotteries, daily fantasy sports),
and requires all of:

- a **valid gambling licence for every country/state where the app is distributed**, with
  the app not exceeding the licence scope;
- **age verification** that prevents under-age use;
- **geo-blocking** of everything outside the licensed footprint;
- **responsible-gambling information** in the app *and* the store listing;
- an **Adults Only (AO)** IARC rating;
- the app must be **free**, and must **not** use Play Billing.

Outside that programme, Google does not allow content that "enables users to wager or
participate using real money to obtain prizes of real world monetary value".

**Where Awalé sits.** `MatchEscrow` takes two equal stakes, pays the winner, and routes a
rake to the Treasury — deployed at **800 bps (8%)**, per `docs/economic-model.md`. The app
sells this in plain words: `app/page.tsx:188` renders "win **real money**", and the
webmanifest description is "Play Awalé and win real money — right in MiniPay." There is a
weekly race prize pool (`WeeklyLeague`), tournament escrows, and a no-loss league vault.

Skill does **not** exempt it. Google's 2025 policy revision explicitly pulled games using
virtual currencies or items with real-world value into the gambling definition, and
third-party skill-based cash tournaments are not an eligible category. The rake is the
aggravating fact: the operator profits from the wagering itself. `docs/economic-model.md`
already names this — *"Regulatory exposure concentrated on the one stream that earns."*

**Risk if submitted anyway:** RMG violations are enforced at the **developer account**
level, not just the app level. A rejection is the good outcome; account termination
(taking any future app with it) is the realistic bad one.

---

## 3. 🔴 Blocker — crypto stakes and tokenized assets

Three separate collisions:

**a) Stablecoin as the stake medium.** The RMG programme is built around licensed
operators moving fiat. Nothing in it contemplates a user staking cUSD/USDC from a
self-custodial wallet. Google's tokenized-content rules bar apps that don't comply with
the RMG policy from accepting money for a chance to win tokenized assets — which is
exactly the flow here.

**b) Cosmetics = in-app digital goods bought outside Play Billing.** `/shop` sells
ERC-1155 board/seed skins for stablecoin (`Cosmetics.buy` → Treasury), priced in-app as
"$0.25" (`src/lib/shop-logic.ts`). Digital content consumed inside the app must use Google
Play Billing. Payment in stablecoin to a smart contract is not Play Billing and cannot be
made into it. The ERC-2981 5% resale royalty compounds this — it makes the app a
marketplace for tradeable assets.

**c) "Earn by playing" promotion.** Play requires apps to be transparent about tokenized
digital assets and forbids promoting the ability to earn from playing or trading. The
home page hero, the manifest description, the `<meta name="description">`, and the Welcome
screen's three promises all lead with earning.

There is no configuration that resolves (a)–(c). They are removals.

---

## 4. 🔴 Blocker — age verification is not enforced

- `app/tos/page.tsx:21` — "You must be at least 18 years old".
- `app/privacy/page.tsx:88` — "not intended for users under 18".
- `app/guide/page.tsx:173` — "18+ only."

Nothing checks. There is **no gate anywhere between app launch and staking money**:
`Welcome.tsx` is a one-screen dismissable intro with no attestation, and the money flow in
`app/matches/page.tsx` never asks.

`PersonhoodVerify.tsx` (Self, `disclosures: { minimumAge: 18, ofac: true }`) is the closest
thing, and it is disqualified three times over:

1. **Optional by design** — its own copy says *"You can play for money right away."* It
   gates weekly-race prize eligibility, not cash play.
2. **Off by default** — `if (!SELF_SCOPE || !SELF_ENDPOINT) return null;`, and
   `.env.example` documents "Leave unset to disable the gate".
3. **Mock by default** — `const SELF_MOCK = process.env.NEXT_PUBLIC_SELF_MOCK_PASSPORT !== "false"`
   means `devMode: true` unless the env var is *literally* the string `"false"`.
   `.env.example` ships `NEXT_PUBLIC_SELF_MOCK_PASSPORT=true`. **Mock passports are
   accepted unless someone remembers to flip it.** This is worth fixing regardless of Play
   — invert the default so production is safe when the env is unset.

For an RMG submission, a self-declared checkbox is not sufficient either: the policy wants
verification that *prevents* under-age use.

---

## 5. 🔴 Blocker — no geo-blocking

A repo-wide search for country/region logic finds exactly one hit, and it is phone-number
formatting (`packages/game-server/src/identity/phone.ts`). There is:

- no IP-country lookup, no `CF-IPCountry` handling, no blocked-jurisdiction list;
- no gating in `MatchEscrow` or the matchmaking queue;
- a privacy policy that offloads this to someone else — *"Location data (beyond MiniPay's
  geo-gating)"* (`app/privacy/page.tsx:29`). Relying on MiniPay's gating is not a control
  we own, and it does not transfer to a Play-distributed Android build at all.

Play requires geo-restriction to the licensed footprint. Independently of Play, real-money
play is a criminal-law matter in a number of markets — including several where MiniPay is
most used.

---

## 6. 🟠 Data Safety form and privacy policy

The privacy policy (`/privacy`) is a good starting point but will not survive the Data
Safety questionnaire as written. Play treats a Data Safety form that contradicts actual app
behaviour as a **Deceptive Behavior** violation.

| Claim in the policy | Reality in the code |
|---|---|
| "We do not collect… IP addresses or device identifiers" | `src/lib/analytics.ts` beacons to `${SERVER_URL}/events`; any HTTP request delivers the IP to the server/host. `src/lib/push.ts` stores a **push endpoint keyed to the wallet address** — a persistent device identifier. |
| "Anonymized usage data" | The funnel events are anonymous, but they are sent from a session that also transmits the wallet address over the same socket — linkable. |
| "No cookies or tracking pixels **for advertising**" | Accurate, but the form asks about all collection, not advertising. |
| Third parties listed: MiniPay, RPC, ODIS | Missing: **Self** (identity/passport attestation), the **game server** itself (Redis/Postgres profiles, ratings, match state), **web push** (VAPID/FCM), and the hosting/CDN providers. |

Further items:

- **Wallet address is personal data** under Play's taxonomy (a persistent user identifier),
  and must be declared as collected *and* shared (it is public on-chain).
- **Phone-derived identity** via ODIS: phone numbers are in Play's sensitive category and
  need explicit declaration plus prominent disclosure.
- **The policy must be reachable at a public URL** from the Play Console listing, without
  installing the app. Today it is a route inside the app bundle. Publish it at a stable
  URL (the Vercel deployment can serve `/privacy` and `/tos` — just pin the domain).
- The policy is dated `2026-07-06` and describes the MiniPay context only; a Play listing
  needs the Android distribution described explicitly.

---

## 7. 🟠 No account deletion path

Play requires apps that let users create an account to provide **in-app account deletion**
plus a **publicly reachable web deletion request URL**.

The policy's answer is *"You cannot delete blockchain data; it is immutable"*
(`app/privacy/page.tsx` §8). That is true of the chain and irrelevant to the obligation:
the off-chain state is deletable and must be deletable on request —

- live match store + leaderboard/ratings (Redis & Postgres adapters, per README);
- push subscriptions (`/push/subscribe`);
- cached ODIS display names;
- funnel counters;
- Self verification records.

There is no `DELETE` endpoint anywhere in `packages/game-server/src`. Needed: a
`/account/delete` server route, a Profile-screen entry point, and a public web form.

---

## 8. 🟠 Content rating

The IARC questionnaire asks directly whether the app enables gambling with real currency.
Answering truthfully yields **AO (ESRB) / 18+ (PEGI)** in most territories — and Play's RMG
policy *requires* the AO rating. AO-rated apps face distribution restrictions of their own.
Answering it any other way is rating misrepresentation, which is its own enforcement track.

Store listing copy will also be read as an RMG self-declaration: the manifest description,
the `<title>`/meta description in `app/layout.tsx`, and the hero string are all "win real
money".

---

## 9. 🟡 Console account prerequisites

- **Closed testing requirement:** personal (non-organisation) developer accounts opened
  recently must run a closed test with **12 testers for 14 continuous days** before applying
  for production access. Budget the calendar time.
- **Developer verification:** legal name, address, and a verified contact. For an org
  account, a D-U-N-S number.
- **EU trader status:** an app handling money is a trader under the DSA; the declaration is
  mandatory and publishes the trader's address.
- The listed contact is `swappilot.exchange@gmail.com`. Legal for a personal account, but an
  RMG-adjacent app reviewed against a licensing requirement will not be helped by a free
  mailbox and no legal entity.

---

## 10. 🟠 Pre-existing product blockers that Play exposure amplifies

`docs/mainnet-checklist.md` still carries, unresolved:

- **[BLOCKER] Partial-transcript challenge attack** — a losing player can submit a valid
  game *prefix* to `challenge`, trigger `_void`, and recover a stake they should have
  forfeited. That is a live fund-loss path.
- **[BLOCKER] No independent external audit.** The `audits/` reviews are self-conducted.
- **Weekly-league pool is an operator IOU**, not an on-chain flow: the UI promises that
  half the house fee returns to players, while prizes are paid by a plain ERC-20 transfer
  from the operator wallet. On a consumer app store, an unbacked payout promise is a
  consumer-protection problem, not just an ops one.
- `NEXT_PUBLIC_CHAIN_ID` defaults to **11142220 (Celo Sepolia)** — a testnet default in a
  shippable build.
- Matchmaking needs a **single server instance** (in-memory queue); no horizontal scale.

Shipping money-handling software with a known fund-loss path to a mass-market store is a
bigger problem than the Play policy itself.

---

## 11. Recommended paths

### Path A — Free-to-play Android build, cash play stays on MiniPay/web *(recommended)*

Ship a Play build that is genuinely free-to-play, and keep the real-money product where it
was designed to live. Concretely, the Android build must have compiled out (not merely
hidden):

- match creation/join with stakes, `MatchEscrow` writes, rake copy, and every "$" price;
- `/shop` (cosmetics purchases) and `/league` (vault deposits);
- weekly race / tournament **cash** prizes;
- all "win real money" / "earn" copy in the manifest, meta tags, hero, Welcome, guide.

What remains is a strong free game: practice vs. the engine, daily puzzle + streak, Quick
Match with ELO, tutorial, skill leaderboard, cosmetic skins earned by rank. That passes
review as an ordinary board game, rates ~PEGI 3 / ESRB E, and still needs items 6, 7, 9 and
the API-36 target fixed.

One caution: do **not** deep-link or advertise the wagering version from inside the free
Android app. Driving Play users to an off-Play real-money experience is treated as
circumvention. Two clean products, no bridge.

### Path B — Licensed RMG submission

Realistic requirements: a licensed legal entity, a gambling licence in each target market,
KYC/AML, enforced age verification, geo-blocking, responsible-gambling tooling
(self-exclusion, deposit limits), an AO rating, and Google's RMG application. Timeline is
quarters-to-years and the cost is six figures. Even then, **stablecoin stakes are outside
what the programme contemplates** — expect the crypto rail itself to be the sticking point.

### Path C — Stay off Google Play

MiniPay listing + PWA install. This is what the product was built for, and it is the only
path where the real-money product ships as designed. Play adds distribution reach that the
current economics (8% rake on $0.15–1 stakes) may not justify against the compliance cost.

---

## 12. If Path A is chosen — ordered checklist

1. Create an Android build target (Bubblewrap TWA over the deployed domain + Digital Asset
   Links), targeting **API 36**.
2. Introduce a build-time flag (e.g. `NEXT_PUBLIC_DISTRIBUTION=play`) that **removes** —
   via tree-shaken conditional imports, not CSS — every route/component in the
   money surface: `/matches` staking, `/shop`, `/league`, cash tournaments, `MatchActions`,
   `PrizeCollect`, and stake copy.
3. Rewrite the money-facing strings: manifest description, `app/layout.tsx` metadata,
   hero, `Welcome.tsx`, `/guide`.
4. Add a server `DELETE /account` + a Profile entry point + a public web deletion form.
5. Publish `/privacy` and `/tos` at a stable public URL; rewrite the privacy policy to
   match reality (IP, push endpoint, wallet address, Self, ODIS, server-side stores) and
   to cover the Android distribution.
6. Fill the Data Safety form from the corrected policy, not from the old one.
7. Complete the IARC questionnaire for the free build.
8. Ship a 512×512 PNG icon + 1024×500 feature graphic + phone screenshots.
9. Run the 12-tester × 14-day closed test.
10. Independently of Play: invert `NEXT_PUBLIC_SELF_MOCK_PASSPORT` so mock passports
    require an explicit opt-**in**, and close the `mainnet-checklist.md` blockers before
    the money build goes anywhere near mainnet.

---

## Sources

- [Real-Money Gambling, Games, and Contests — Play Console Help](https://support.google.com/googleplay/android-developer/answer/9877032)
- [Developer Program Policy — Play Console Help](https://support.google.com/googleplay/android-developer/answer/16549787)
- [Target API level requirements for Google Play apps](https://support.google.com/googleplay/android-developer/answer/11926878)
