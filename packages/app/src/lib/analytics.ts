// Funnel events — fire-and-forget, anonymous (a name, nothing else). The
// server keeps per-day counters so we can see WHERE first-time players drop
// off (open → practice → quick match → money) instead of guessing at churn.

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

export type FunnelEvent =
  | "app_open"
  | "tutorial_done"
  | "practice_start"
  | "quick_match_start"
  | "money_open"
  | "match_created"
  | "match_joined"
  | "daily_solved";

const sent = new Set<string>(); // once per event per session — counts people, not taps

export function track(name: FunnelEvent): void {
  if (!SERVER_URL || sent.has(name)) return;
  sent.add(name);
  try {
    // Cross-origin, credential-free, fire-and-forget. NOT navigator.sendBeacon:
    // beacons always attach credentials (cookies), which the browser rejects
    // against the server's wildcard CORS (`Access-Control-Allow-Origin: *`) —
    // producing a console CORS error and dropping every funnel event in prod.
    // A plain fetch defaults to `credentials: "same-origin"`, so it sends NO
    // credentials cross-origin and the wildcard is accepted. Omitting an explicit
    // content-type keeps it a "simple" request (text/plain, no preflight); the
    // server reads the raw body with readJson() regardless of content-type.
    void fetch(`${SERVER_URL}/events`, {
      method: "POST",
      body: JSON.stringify({ name }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* analytics must never break the app */
  }
}
