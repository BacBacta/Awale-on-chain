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
    const body = JSON.stringify({ name });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(`${SERVER_URL}/events`, new Blob([body], { type: "application/json" }));
    } else {
      void fetch(`${SERVER_URL}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    /* analytics must never break the app */
  }
}
