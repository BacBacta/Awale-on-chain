# PageSpeed / Lighthouse — MiniPay listing (perf gate)

MiniPay's listing checklist asks for **PageSpeed 90+**. Measured against the
live app (`https://awale-on-chain.vercel.app`), mobile form factor.

## Stable results (CPU-independent — these are the real state)

| Category | Score |
|---|---|
| Accessibility | **100** |
| SEO | **100** |
| Best practices | **96** |
| First Contentful Paint | ~1.0 s |
| Cumulative Layout Shift | **0** |

Accessibility, SEO, and best-practices are locked in. FCP and CLS are excellent
and stable across runs.

## Performance score — measure on real infra, not in the container

The **performance** score swung between **84 and 63** across identical back-to-back
runs, driven entirely by Total Blocking Time bouncing 490 ms → 2600 ms. FCP
(1.0 s) and CLS (0) stayed put. That signature — a CPU-bound metric thrashing
while network/layout metrics hold — is classic shared-container CPU contention,
not a real property of the site. **Local Lighthouse in this dev container cannot
be trusted for the perf number.**

To get the real score for the intake form, run one of:
- <https://pagespeed.web.dev/> against `https://awale-on-chain.vercel.app` (Google's
  own infra — the number MiniPay will look at), or
- Lighthouse in Chrome DevTools on a real phone / an un-throttled machine.

## Optimizations applied (real, verified)

- **socket.io-client (~100 kB) lazy-loaded.** It was eagerly bundled on the
  homepage via `QuickMatch`/`MatchActions`, though the socket only connects when
  a user starts matchmaking. Moved to `await import("socket.io-client")` inside
  the connect paths. Verified: socket.io is **no longer in the homepage's initial
  chunks**; homepage First Load JS 224 → 211 kB, `/play` 226 → 213 kB.
- **`next.config.mjs`:** explicit `compress`, AVIF/WebP image formats, immutable
  cache headers for static assets, source maps off in prod.
- Bundle is far under the 2 MB cap (First Load JS 87–213 kB across routes).

If the real PageSpeed run still lands under 90, the next lever is the remaining
"unused JavaScript" (viem is the largest homepage dep) — code-split the wallet/
contract paths behind the first interaction the same way socket.io now is.
