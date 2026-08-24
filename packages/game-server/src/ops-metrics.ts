// Operational metrics MiniPay's readiness review asks for that the on-chain
// indexer cannot derive on its own.
//
//  - **Top countries** — MiniPay's availability differs per market, so reviewers
//    want the geographic split. It comes from the edge proxy's geo header; no
//    IP is ever stored, only an ISO country code counter.
//  - **Failed-transaction rate** — a proxy for UX and contract bugs. Deriving it
//    from logs is impossible (a reverted tx emits none) and receipt-scanning
//    every block is far too expensive, so the app reports the outcome of each
//    money write it submits and this aggregates the ratio.
//
// Both are plain per-day counters, deliberately anonymous: a country code and a
// tally, nothing that identifies a player.

/** Header names carrying an ISO-3166-1 alpha-2 country, in order of trust.
 *  Which one exists depends on what fronts the server (Cloudflare, Vercel,
 *  Fly). If none is present the hit is counted as unknown rather than guessed. */
const COUNTRY_HEADERS = [
  "cf-ipcountry", // Cloudflare
  "x-vercel-ip-country", // Vercel
  "fly-client-country", // Fly.io (when geo is enabled)
  "x-country-code", // generic reverse proxies
] as const;

/** Extract the viewer's country from proxy headers. Returns null when no
 *  header is present or the value isn't a plausible ISO code — never a guess. */
export function countryFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  for (const name of COUNTRY_HEADERS) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) continue;
    const code = value.trim().toUpperCase();
    // Cloudflare sends XX for anonymised/unknown clients, T1 for Tor
    if (code === "XX" || code === "T1") return null;
    if (/^[A-Z]{2}$/.test(code)) return code;
  }
  return null;
}

/**
 * Share of submitted money transactions that failed, in [0, 1].
 *
 * The denominator is every submission the app reported, so a run of zero
 * traffic reports 0 rather than dividing by zero. User cancellations are not
 * counted by the caller — declining a wallet prompt is not a failure.
 */
export function failedTxRate(sent: number, failed: number): number {
  const total = sent + failed;
  return total === 0 ? 0 : failed / total;
}

/** Country tallies, busiest first, for the stats page. `limit` caps the list;
 *  the tail is dropped rather than lumped into an "other" bucket that would
 *  read as a country. */
export function topCountries(
  counts: Record<string, number>,
  limit = 5,
): { country: string; count: number }[] {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    // count desc, then country asc so equal counts have a stable order
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([country, count]) => ({ country, count }));
}
