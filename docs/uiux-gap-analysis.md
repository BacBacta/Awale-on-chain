# UI/UX Gap Analysis — Awalé Mini-App

**Date:** 2026-06-19
**Scope:** `packages/app` (Next.js mini-app, MiniPay target, 360×640 viewport)
**Benchmark:** best-in-class 2026 mobile experiences — Lichess/chess.com (board-game UX gold
standard), Monument Valley / Alto's Odyssey (premium mobile-game materiality & motion),
Duolingo (delight + retention loops), Cash App / Robinhood (financial trust & number-craft),
Linear / Things 3 (motion polish & haptic density).

**One-line verdict:** the app is a *correct, shippable prototype* with a *spartan, undifferentiated
UI*. It clears "it works"; it is nowhere near "premium." The single largest missed opportunity is
the **board itself** — the hero surface of the product — which renders as flat gray circles with
integer labels and has zero motion, materiality, or feedback.

Severity legend: **P0** = blocks a "premium" claim / hurts trust or conversion · **P1** = clear
quality gap a discerning user notices · **P2** = polish / delight upside.

---

## 0. Executive summary — the 8 things that matter most

| # | Gap | Where | Sev |
|---|-----|-------|-----|
| 1 | Board renders counts, not seeds; no sowing/capture animation | `Board.tsx` | **P0** |
| 2 | No design-token system, no type scale, no elevation/motion language | `globals.css` (85 lines) | **P0** |
| 3 | Raw wallet/exception strings shown to users as primary feedback | `MatchActions.tsx:72`, `LiveMatch.tsx:99` | **P0** |
| 4 | No first-run/empty/loading states; "Connecting…" plain text is the onboarding | `page.tsx`, `LiveMatch.tsx` | **P0** |
| 5 | Money/stake/pot surface has no clarity, no trust signals, no settlement timeline | `MatchActions.tsx`, `LiveMatch.tsx` | **P0** |
| 6 | Zero haptics, zero sound, no win/loss celebration (`lottie-react` is installed but unused) | global | **P1** |
| 7 | No brand/cultural identity — Awalé's West-African heritage is invisible | global | **P1** |
| 8 | No i18n despite a francophone/African core audience | global | **P1** |

If you fix only #1–#5 you move from "prototype" to "credibly good." #6–#8 are what make it *premium*.

---

## 1. Visual foundations & design system

**Current state.** `app/globals.css` is 85 lines: a flat palette of 8 CSS variables, one button
style, one card style, `.row`/`.pad`/`.title`/`.muted`. No spacing scale, no type scale, no
elevation/shadow system, no border/radius tokens beyond ad-hoc values, no motion tokens, no
light/dark handling, no focus-visible styling. Layout is a hardcoded `360px` frame
(`layout.tsx:20`), so it renders as a tiny letterboxed column on anything wider than a phone.

**Premium benchmark.** Linear/Things ship a tokenized system: a modular type scale (e.g.
12/14/16/20/28/40 with tuned line-heights and letter-spacing), an 8pt spacing grid, 2–3 elevation
levels with layered soft shadows, semantic color roles (surface/on-surface/accent/positive/
negative/warning), and motion tokens (duration + easing curves). Everything composes from tokens.

**Gap & actions.**
- **P0** Introduce a token layer (CSS custom properties or a lightweight system) for: spacing
  (`--space-1..8`), radius, type scale, elevation (`--shadow-sm/md/lg`), and motion
  (`--ease-out`, `--dur-fast/med`). Today every component hand-rolls inline `style={{}}`.
- **P0** Replace `system-ui` with an intentional type pairing — a characterful display face for the
  brand/headlines + a clean UI face for body/numbers. Numbers especially (stake, pot, score) want a
  tabular-figure font so they don't jitter as they change.
- **P1** Make the frame responsive: center a phone-width column on desktop with an ambient
  background, instead of a 360px box on a black void.
- **P1** Add `:focus-visible` rings and a real pressed/hover/disabled state vocabulary on `.btn`
  (currently a single flat green rectangle).

---

## 2. The board — the hero surface (highest leverage)

**Current state** (`Board.tsx`). The board is a static SVG: a brown rounded rect, two store
rects, twelve `<circle>` pits each with a centered **integer** of the seed count. There are no
seeds drawn. Nothing moves. A playable pit just gets a green stroke. Tapping calls `onPlay`
and the whole `GameState` swaps instantly to the next position — no sowing animation, no capture
highlight, no count tick-up. The bot in `LocalDemo` plays `legalHouses(next)[0]` synchronously
in a `while` loop, so the opponent's entire turn resolves in one frame.

**Why this is the #1 issue.** In a board game the board *is* the product. Lichess/chess.com spend
enormous craft on piece movement, last-move highlight, capture animation, check glow, premove feel,
and sound. Monument Valley/Alto win on materiality and motion. Awalé's core loop — *sowing seeds
counter-clockwise one pit at a time, then capturing* — is inherently tactile and satisfying, and we
currently throw all of it away by jumping straight to the end state with a number swap.

**Gap & actions.**
- **P0** Render actual seeds (small textured ovals) distributed in each pit, not a single integer.
  Keep the count as a secondary badge for legibility. This alone transforms perceived quality.
- **P0** Animate **sowing**: when a pit is played, lift its seeds and drop them one-by-one into
  successive pits counter-clockwise, with a staggered spring and a soft "tick" per drop. This is the
  signature interaction — it should feel like the real game.
- **P0** Animate **capture**: when seeds are captured into a store, flash the captured pits and fly
  the seeds into the store with the store count ticking up. This is the dopamine moment of Awalé.
- **P1** Bot "thinking": give the opponent a short, variable delay + a subtle pit-considering pulse
  instead of resolving its turn in a synchronous loop (`LocalDemo.tsx:43-49`).
- **P1** Last-move indicator (which pit your opponent just played from/into) so the board is
  readable turn-to-turn.
- **P1** Illegal/empty-pit tap feedback: a gentle shake + haptic, not silent no-op
  (`LocalDemo.tsx:38` just returns).
- **P2** Materiality pass: wood grain texture, soft inner shadow in pits, seed shading, ambient
  light. Lean into the carved-wood aesthetic.

---

## 3. Motion & micro-interactions

**Current state.** None. No transitions on mount/route-change, no button press animation, no spring
physics, no haptics, no sound. `lottie-react` is in `package.json` dependencies but is **not
imported anywhere** — dead weight today, latent capability for celebrations.

**Premium benchmark.** Premium apps have a *motion language*: shared element transitions between
lobby↔match, springy buttons, list items that stagger in, numbers that count up, and — on mobile —
generous **haptics** (selection tick on legal move, success thud on capture, win pattern) and
**sound** (sowing ticks, capture chime, win fanfare, all mutable). Duolingo's retention is built on
this feedback density.

**Gap & actions.**
- **P1** Add a motion primitive layer (CSS transitions + a spring lib, or `framer-motion`) and apply
  to: button press, card mount, route transitions, status changes.
- **P1** Haptics via `navigator.vibrate` (web) where available: selection tick on tap, capture
  success, win/lose patterns. Cheap, huge perceived-quality lift on mobile.
- **P1** Optional sound design (sowing tick, capture, win), default-on with a persistent mute toggle.
- **P0**→**P1** Wire `lottie-react` (already installed) to a **win/lose/draw celebration** —
  currently a win is the text "You win 🎉" in a card (`LocalDemo.tsx:32`, `LiveMatch.tsx:88`).
- **P2** Respect `prefers-reduced-motion` — gate all of the above behind it.

---

## 4. Game feel & state feedback

**Current state.** Turn state is a single muted line: "Your turn" / "Opponent…" / a result string,
plus a `store0 – store1` score (`LocalDemo.tsx:68-73`, `LiveMatch.tsx:128-133`). End-of-game is the
same card with different text and, in the demo, a "Play again" button. No countdown, no turn timer,
no momentum indicator, no capture feed, no "you're ahead/behind" affordance.

**Gap & actions.**
- **P1** Make whose-turn unmistakable: animate the active player's side, dim the inactive side, show
  an avatar/name per side (not just a raw `0x…` short address).
- **P1** Win/lose/draw is a *moment* — full-screen celebration (confetti/lottie), final score
  emphasized, pot won shown in money terms, primary CTA ("Play again" / "Rematch" / "Share").
- **P1** Surface a turn timer / abandonment clock when stakes are real — players need to know the
  challenge-window and TTL mechanics they're already subject to on-chain.
- **P2** Capture feed / move history strip so a spectator (`watch` mode exists in `LiveMatch`) can
  follow the game.

---

## 5. Money, stake & trust surface (web3-specific, premium-financial)

**Current state.** The lobby's value prop is a text card: "Play for stablecoin / Winner takes the
pot, minus a small protocol fee" (`page.tsx:58-62`). Create-match is a bare text input defaulting to
`"1"` with no currency symbol, no balance shown, no pot preview, no fee breakdown
(`MatchActions.tsx:118-129`). Status is plain text: "Confirming…", "Match #N created", or a raw
error. Settlement shows as a string append: "· settled on-chain ✅" (`LiveMatch.tsx:97`). "View
receipt" is a muted link.

**Premium benchmark.** Cash App / Robinhood make money legible and *trustworthy*: explicit amounts
with currency, balance awareness, a clear "you stake X → pot is 2X → you win Y after Z% fee"
breakdown *before* you commit, a stepper/preset chips instead of a naked text field, transaction
states as a timeline (submitted → confirmed → settled) with real status chips, and human-readable
outcomes.

**Gap & actions.**
- **P0** Stake input: show currency symbol + token, the user's available balance, quick-pick chips
  (1 / 5 / 10), and a **pot & payout preview** ("Pot 2.00 · You win 1.95 after 2.5% fee"). The rake
  is already computed on-chain — mirror it in the UI before commit.
- **P0** Replace raw `error.message` with mapped, human messages (insufficient balance, rejected in
  wallet, opponent already joined, etc.). Dumping `ERC20InsufficientAllowance`-class strings is a
  trust killer.
- **P0** Transaction lifecycle as a **status timeline/stepper** with proper chips, not appended
  text — covering approve → stake → joined → settling → settled, mapped to the contract's
  Active/Proposed/Settled states.
- **P1** Trust signals on the money surface: contract address (verified ✓ link to Celoscan, which we
  just verified), "non-custodial", "winner-takes-pot" badge, challenge-window explainer.
- **P1** Empty/pending lobby: "Match #N created — waiting for an opponent" should be a live,
  shareable card with a copy-link/QR to invite, not a status string (`MatchActions.tsx:70`).

---

## 6. Onboarding, first-run & empty states

**Current state.** First run outside MiniPay: header says "Open in MiniPay" and you get a stake card
+ "Play a demo game" (`page.tsx:46,63`). Inside MiniPay pre-connect: "Connecting…" plain text. No
tutorial, no rules explainer, no illustration, no progressive disclosure. A new user who has never
played Awalé has no way to learn the rules in-app.

**Premium benchmark.** Duolingo/Monument Valley onboard with a guided, low-friction first session
and teach by doing. For a traditional game many users *don't know the rules*, an interactive
"learn in 20 seconds" path is table stakes.

**Gap & actions.**
- **P0** Real loading states (skeletons/spinners with personality) instead of "Connecting…" /
  "Loading…" strings (`LiveMatch.tsx:29`, `page.tsx:46`).
- **P1** Interactive rules/tutorial: a guided first sow + capture, reachable from the lobby and
  auto-offered on first run.
- **P1** First-run value moment: an animated board hero on the lobby instead of a text card.
- **P2** Identity: replace `0x1234…abcd` short addresses (`identity.ts`/`shortAddress`) with
  ENS/Self-verified names + avatars; Self personhood is already integrated
  (`PersonhoodVerify.tsx`) — surface the verified badge as a trust/identity asset.

---

## 7. Information architecture & navigation

**Current state.** Three routes: `/` (lobby), `/play` (demo or `?match=N` live), `/stats`.
Navigation is text links ("← Back", "View stats"). No persistent nav, no match history, no
active-matches list, no profile. A user with multiple in-flight matches has no home for them.

**Gap & actions.**
- **P1** A "Your matches" surface: active / waiting / finished, each a card with state chip and CTA.
  Today `openId` is a single transient value (`MatchActions.tsx:23`).
- **P1** Persistent bottom nav (Play / Matches / Stats / Profile) appropriate to a mobile mini-app.
- **P2** Match history with replays (the transcript exists on-chain — replays are a premium,
  shareable feature).

---

## 8. Stats, social & retention

**Current state.** `/stats` is a flat list of rows with several `"—"` placeholders shown literally
(`stats/page.tsx:31-32`), plus per-token volume/revenue. It's an *operator* dashboard (DAU/MAU/
retention — a MiniPay listing requirement) rendered as the *user-facing* stats page.

**Gap & actions.**
- **P1** Separate **player-facing** stats (your record, streak, winnings, rank) from operator
  metrics. A user doesn't care about D7 retention; they care about *their* streak.
- **P1** Leaderboard + shareable result cards (image export) — core web3-game virality loop.
- **P2** Don't render `"—"` to users; hide or label "coming soon" unavailable metrics.

---

## 9. Accessibility & inclusivity

**Current state.** Some `aria-label`s exist (good — `Board.tsx:60`, inputs in `MatchActions`). But:
no focus-visible styling, tap targets not audited (44px min), color-only state signaling (green
stroke = playable), no reduced-motion handling (moot today, critical once motion lands), and **no
i18n** despite an audience that is heavily francophone/African.

**Gap & actions.**
- **P1** **Localization** (FR first, then likely regional languages) — high ROI for this audience.
- **P1** Don't rely on color alone for "playable"/turn state; add shape/motion/label.
- **P1** Focus-visible rings, 44px tap targets, contrast audit on `--muted` (#9bb09c on #18201a is
  borderline for small text).
- **P2** Screen-reader narration of board state and moves.

---

## 10. Brand & cultural identity (the differentiator)

**Current state.** None. The word "Awalé", a generic green accent, system fonts. Nothing signals
that this is one of humanity's oldest games, rooted in West-African Oware/Mancala tradition.

**The opportunity.** This is the single biggest *differentiation* lever. A premium Awalé app should
own a distinct visual world — carved-wood materiality, real seed textures (the game is traditionally
played with caltrop/oware seeds), warm earth tones, a characterful display font, a signature sowing
sound — the way Monument Valley owns its aesthetic. The mechanics are already faithful (the engine is
parity-proven); the *presentation* should be equally proud of the heritage. This costs design
direction, not engineering complexity, and it's what turns "a mancala clone" into "*the* Awalé app."

---

## Prioritized roadmap

**P0 — required to credibly claim quality (do first):**
1. Design-token + type-scale foundation (§1) — unblocks everything else.
2. Board: render seeds + sowing + capture animation (§2) — highest single leverage.
3. Money surface: stake input with balance/pot/fee preview + payout (§5).
4. Human-readable errors + transaction status timeline (§5).
5. Real loading/empty states (§6).

**P1 — clear premium gaps a discerning user notices:**
6. Motion language + haptics + win celebration (wire the already-installed lottie) (§3, §4).
7. Turn-state clarity, avatars/names over raw addresses (§4, §6).
8. "Your matches" + nav (§7).
9. Player-facing stats + shareable result cards (§8).
10. i18n (FR) + a11y pass (§9).

**P2 — delight & differentiation:**
11. Cultural/material identity pass — wood, seeds, sound, type (§10).
12. Interactive rules tutorial (§6).
13. Match replays from on-chain transcripts (§7).

**Quick wins (high ratio, low effort):** human error map (§5), focus-visible + tap-target pass (§9),
hide raw `"—"` in stats (§8), responsive frame instead of 360px box (§1), bot "thinking" delay (§2),
illegal-tap shake + `navigator.vibrate` (§3).

---

## Note on the benchmark

"Ultra premium 2026" for a MiniPay mini-game realistically means: **Lichess-grade board feel +
Cash-App-grade money clarity + Duolingo-grade feedback density + a proud cultural identity**, all
inside a 360px-first, low-bandwidth, instant-load mobile envelope. The constraint (mini-app, mobile,
stablecoin stakes) is not an excuse for spartan — it's the design brief.
