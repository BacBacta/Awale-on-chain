// Beacon relay for the anonymous funnel counters.
//
// The counters live on the game server, but the visitor's COUNTRY cannot reach
// it directly: the server runs on Fly, whose proxy exposes `Fly-Client-IP` and
// `Fly-Region` — the datacenter it answered from, not where the player is — so
// a beacon posted straight there can never be attributed to a market. This app
// runs on Vercel, whose edge does set `x-vercel-ip-country`, so the beacon
// lands here first and this hop forwards the country onward.
//
// MiniPay's readiness review weighs the geographic split, because Mini App
// availability differs per market (docs/deployment.md §5).
//
// Nothing identifying crosses this hop: an event name and a two-letter country
// code, never the IP. The country is read from the platform header only — a
// value the client cannot set through Vercel's edge — and the body is
// re-serialised rather than streamed through, so a caller cannot smuggle extra
// fields to the game server. These are public, anonymous tallies either way;
// a determined client could always post to the server directly, which is why
// they are counters and not something anything trusts.

export const dynamic = "force-dynamic"; // a beacon must never be cached

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

export async function POST(req: Request): Promise<Response> {
  // No server configured: accept and drop, exactly as the client did before.
  // 204 keeps sendBeacon quiet — a failed beacon would retry against a target
  // that will never exist.
  if (!SERVER_URL) return new Response(null, { status: 204 });

  let name: unknown;
  try {
    ({ name } = (await req.json()) as { name?: unknown });
  } catch {
    return new Response(null, { status: 204 });
  }
  if (typeof name !== "string") return new Response(null, { status: 204 });

  const country = req.headers.get("x-vercel-ip-country") ?? req.headers.get("cf-ipcountry");

  try {
    await fetch(`${SERVER_URL}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // forwarded under the name the game server already looks for
        ...(country ? { "x-vercel-ip-country": country } : {}),
      },
      body: JSON.stringify({ name }),
    });
  } catch {
    /* analytics must never surface as an error to the player */
  }
  // always 204: the caller is a fire-and-forget beacon with nothing to do
  // about a failure, and a non-2xx would only make some browsers retry
  return new Response(null, { status: 204 });
}
