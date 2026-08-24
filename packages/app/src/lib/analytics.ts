// Funnel events — fire-and-forget, anonymous (a name, nothing else). The
// server keeps per-day counters so we can see WHERE first-time players drop
// off (open → practice → quick match → money) instead of guessing at churn.

// Posted to our OWN /api/events, not straight to the game server. That hop
// exists to attach the visitor's country: the game server runs on Fly, whose
// proxy reports the datacenter rather than the player, while this app runs on
// Vercel, whose edge sets the real country header. Same-origin also means no
// CORS preflight on a beacon.
const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";
/** Same-origin relay that stamps the country before forwarding (see above). */
const EVENTS_ENDPOINT = "/api/events";

export type FunnelEvent =
  | "app_open"
  | "tutorial_done"
  | "practice_start"
  | "quick_match_start"
  | "money_open"
  | "match_created"
  | "match_joined"
  | "daily_solved";

/** Money-write outcomes. Unlike funnel events these are counted EVERY time,
 *  not once per session — they are a rate, so every submission must land in
 *  the denominator. Feeds the failed-tx rate on the public stats page. */
export type TxEvent = "tx_sent" | "tx_failed";

const sent = new Set<string>(); // once per event per session — counts people, not taps

/** Post an event without the once-per-session guard. Fire-and-forget and
 *  anonymous, exactly like {@link track}; never throws. */
export function countEvent(name: TxEvent): void {
  if (!SERVER_URL) return;
  try {
    const body = JSON.stringify({ name });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(EVENTS_ENDPOINT, new Blob([body], { type: "application/json" }));
    } else {
      void fetch(EVENTS_ENDPOINT, {
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

export function track(name: FunnelEvent): void {
  if (!SERVER_URL || sent.has(name)) return;
  sent.add(name);
  try {
    const body = JSON.stringify({ name });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(EVENTS_ENDPOINT, new Blob([body], { type: "application/json" }));
    } else {
      void fetch(EVENTS_ENDPOINT, {
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
