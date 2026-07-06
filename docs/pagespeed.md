# PageSpeed / Lighthouse — MiniPay listing (perf gate)

MiniPay's listing checklist asks for **PageSpeed 90+**. Measured against the
live app (`https://awale-on-chain.vercel.app`), mobile, via
[pagespeed.web.dev](https://pagespeed.web.dev/) (Google's own infra — the number
MiniPay looks at). **Local Lighthouse in this dev container is CPU-noise-bound
and must not be trusted for the perf number** (it swung 84↔63 on identical runs
while the real PSI run was a stable 82).

## Result: 93 — gate cleared ✅

After the fixes below, PSI mobile perf went **82 → 93** (> the 90 MiniPay gate),
A11y 100 / best-practices 96 / SEO 100 unchanged. The LCP fix landed as expected.

## PSI baseline that drove the fix (6 Jul 2026, mobile)

| Category | Before | After |
|---|---|---|
| **Performance** | **82** | **93** ✅ |
| Accessibility | 100 | 100 |
| Best practices | 96 | 96 |
| SEO | 100 | 100 |

Metrics: FCP **0.8s** ✓ · TBT **0ms** ✓ · CLS **0** ✓ · **LCP 4.5s** ✗ · Speed Index 4.3s ✗

Everything was green **except LCP** (4.5s). PSI's breakdown put **3.56s of that
in the LCP element's render delay** — the element being the hero board's seed
sprite (`/assets/seed.webp`). The homepage is a client component, so the SVG
board only mounts after hydration; the sprite couldn't paint before that, and
it was a 33 KB PNG fetched late.

## Fixes applied (live)

1. **WebP hero assets.** seed 33 KB → **2 KB** (−93%), wood 324 KB → **18 KB**
   (−95%). On simulated slow-4G that ~340 KB is the bulk of the LCP resource
   time. Quality verified visually. Refs migrated (Board default + classic/amber
   skins).
2. **Preload the LCP sprite** at `fetchpriority=high` in the layout head, so its
   fetch leaves the LCP critical path (PSI's own recommendation). Verified live:
   `<link rel="preload" as="image" href="/assets/seed.webp" fetchPriority="high">`.
3. Earlier: socket.io-client lazy-loaded out of First Load; `next.config` perf
   (compress, image formats, immutable cache headers).

Expected effect: LCP resource time collapses (2 KB, preloaded) and the sprite is
cached the instant the board mounts — LCP should fall well under the 4.5s that
capped the score at 82. **Re-run pagespeed.web.dev to confirm 90+.**

## If still under 90

Next lever is the ~65 KB "unused JavaScript" PSI flagged — viem is the largest
homepage dep; code-split the wallet/contract paths behind the first interaction
the same way socket.io now is. Also: the render delay is fundamentally hydration
time on a `"use client"` homepage — converting the static hero shell to a server
component (so the board's container paints server-side) would cut it further.
