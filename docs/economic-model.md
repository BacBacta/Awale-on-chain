# Economic model — critique & recommendation

**Date:** 2026-06-22
**Question:** a revenue model that doesn't break the app, doesn't deter players (churn),
and actually earns. Grounded in the code as built.

---

## 1. What actually earns today

| Stream | Mechanism | Reality |
|---|---|---|
| **Rake on cash matches** | `MatchEscrow._payout`: `rake = pot * rakeBps/10000` (rakeBps=250 → **2.5%**, capped 10%) → Treasury | The *only* live revenue. Earns **only on settled cash games**. |
| **Cosmetics** | `Cosmetics.buy` → stablecoin to Treasury; **5% ERC-2981** resale royalty | Tiny; board/seed skins, low willingness-to-pay. |
| **League yield** | `HarvestVault`: **100% of yield → players**, principal returned | **Protocol takes 0%.** Pure cost/feature, no revenue. |

**Net:** revenue ≈ *rake × cash-match volume* (deployed rake is **800 bps = 8%**, not the 250 code default — set via `RAKE_BPS` at deploy). Everything else earns ~nothing.

> ⚠️ **Weekly-league pool funding — operator-funded, NOT on-chain (mainnet item, "D9").**
> The UI says "half of every house fee feeds the weekly pot, so the fee partly comes back
> to players" (`guide`). That is an **accounting convention**, not an on-chain flow:
> - On-chain, 100% of the rake goes to the **Treasury** (`MatchEscrow._payout` → `treasury`).
> - The weekly-league pool is a **number in Redis** (`WeeklyLeague.recordGame`, `poolShareBps=5000`).
> - Prizes are paid **from the operator wallet** via a plain ERC-20 `transfer` (`main.ts leaguePayout`),
>   so ops must keep the operator funded to cover the promised pool share.
>
> There is **no smart-contract link routing rake → league prizes**. Before mainnet, either
> (a) accept and monitor the operator-funding obligation (treasury → operator top-up routine),
> or (b) route the pool share on-chain (a `MatchEscrow`/Treasury change). Until then the
> "fee comes back to players" promise depends entirely on ops discipline.

---

## 2. Critique

**a) The whole model rides on the weakest part of the funnel.**
Revenue = rake = cash play. But cash play is the **highest-friction, smallest** segment
(needs MiniPay + funded balance + personhood gate + an opponent at a stake). The engagement
we actually built — Quick Match vs AI, daily puzzle, streak, correspondence, social — is **all
free and earns $0**. We monetize the 5% who stake, not the 95% who engage.

**b) Rake on a 2-player zero-sum game is structurally churn-inducing.**
The pot is zero-sum; the rake makes the *player pool net-negative*. Over time the average
casual player **loses money to the house**. Sharks profit, fish churn. That's the classic
real-money-skill trap — and it's the single biggest *dissuasive* force in the current model.
(2.5% itself is fine — poker is 2.5–5% — the problem is *what it's levied on*.)

**c) Dust matches earn nothing but cost everything.**
No stake floor → on small stakes `rake` truncates to ~0 (integer math), yet each match costs
gas + infra. Revenue per match can be negative.

**d) The best asset for revenue is unmonetized.**
The **no-loss vault** (HarvestVault) is the ideal revenue surface — it monetizes *idle capital*,
not gameplay, and feels free (principal always returns). Today it gives **all** yield away.

**e) Regulatory exposure concentrated on the one stream that earns.**
Real-money rake is gambling-adjacent (jurisdiction-dependent). Tying ~all revenue to it is also
a *regulatory* single point of failure, not just a product one.

---

## 3. Principles for a model that earns without deterring

1. **Free to play, pay to flex / save / compete.** Never gate the core fun.
2. **Monetize whales and idle capital, not the casual majority.** The free crowd is the
   network/engagement; don't tax it.
3. **Several small streams, not one fragile rake.** Resilient + lower regulatory concentration.
4. **Charge on value gained, never as an upfront wall** (yield-share, prize-pool cut), and keep
   it **transparent** (we already show the fee preview — keep that).

---

## 4. Recommended model (layered, by value × low-friction × low blast-radius)

### ★ A. Take a slice of the League **yield** (not principal) — *best lever*
A 15–20% protocol cut of the **yield only**; players keep no-loss + ~80% of yield.
- **Non-dissuasive:** you never lose principal — it only ever gains; a smaller win still feels free.
- **Scales with TVL**, not with gambling volume. DeFi-native, defensible, regulation-friendlier.
- **Cost:** a `HarvestVault` change (route a yield share to Treasury at `finalize`) + redeploy.
  Medium blast-radius, contained.

### ★ B. **Season / Battle Pass** — recurring, cosmetic, optional
A cheap seasonal pass (~$2–5) with a **free track + paid track**: cosmetic rewards, profile
flair, faster skin unlocks, tied to the **daily streak + ELO ladder** we already built.
- **Non-dissuasive:** purely optional + cosmetic; the free track keeps everyone engaged.
- **Recurring** revenue from *engaged non-cash* players — exactly the crowd we don't monetize today.
- **Blast-radius:** additive (new contract + UI). Low risk.

### ★ C. **Tournaments** with an entry fee → cut of the prize pool
Scheduled events: pay an entry fee, protocol takes a small % of the pooled prizes.
- Concentrates cash play (fixes 1v1 liquidity) and creates **events** (retention) at once.
- **Non-dissuasive:** optional, and the *prize pool is the draw* (positive framing vs a rake tax).
- **Blast-radius:** new tournament contract/flow. Medium.

### B-tier (add later)
- **Pro subscription** (light): post-game **AI analysis** of your moves (we already have the
  engine + minimax — "show me my blunders"), advanced stats, unlimited correspondence, priority
  matchmaking. Convenience/cosmetic, **never pay-to-win**. Recurring.
- **Cosmetics shop** depth (seasonal skins, gacha-style) + the 5% resale royalty already in place.
- **Sponsored boards / ecosystem grants** (Celo/MiniPay): branded board skins, sponsored
  tournaments — realistic early B2B revenue, non-intrusive.

### Keep, but refine — the rake
Keep 2.5% as a *secondary* stream for the cash minority, plus:
- **Stake floor** (`minStake`) so dust matches don't exist (kills negative-margin games).
- **Rakeback/VIP**: return part of the rake to high-volume players → retains the segment that
  actually pays.
- Optional: **0 rake on the smallest tier** to remove the casual-loss sting, full rake on big pots.

### Avoid (these *break* it or deter)
Pay-to-win (any paid gameplay edge) · gating core modes behind payment · intrusive ads · a high
rake · anything that makes the free majority feel taxed.

---

## 5. Phased rollout (risk-ordered)

1. **Now (additive, low risk):** Season/Battle Pass (B) + cosmetics depth + the AI post-game
   analysis behind a light Pro tier. No core-contract changes.
2. **Next (one contract change each):** League **yield-share** (A) + **stake floor** + rakeback.
3. **Then:** Tournaments (C), sponsored boards, Pro subscription expansion.

> **Thesis:** stop depending on a gambling rake levied on the casual core. Earn from **idle
> capital (yield-share)**, **optional cosmetics/passes**, and **events (tournaments)** — three
> resilient streams that ride the *free* engagement we already built, monetize whales and TVL,
> and leave the 95% who just want to play feeling like the game is free. The rake becomes a
> small, floored, transparent side-stream rather than the whole business.
