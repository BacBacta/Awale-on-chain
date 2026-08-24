import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// the route reads NEXT_PUBLIC_SERVER_URL at module load, so set it before import
process.env.NEXT_PUBLIC_SERVER_URL = "https://server.test";
const { POST } = await import("./route.js");

type Captured = { url: string; init: RequestInit };
let calls: Captured[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(null, { status: 200 }));
  });
});
afterEach(() => vi.unstubAllGlobals());

function beacon(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://app.test/api/events", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const forwardedHeaders = (c: Captured) => c.init.headers as Record<string, string>;

describe("/api/events relay", () => {
  it("forwards the event to the game server", async () => {
    await POST(beacon({ name: "app_open" }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://server.test/events");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ name: "app_open" });
  });

  // the whole reason this hop exists: Fly cannot see the player's country,
  // Vercel's edge can
  it("stamps the country from the platform header", async () => {
    await POST(beacon({ name: "app_open" }, { "x-vercel-ip-country": "KE" }));
    expect(forwardedHeaders(calls[0])["x-vercel-ip-country"]).toBe("KE");
  });

  it("omits the country when the platform did not provide one", async () => {
    await POST(beacon({ name: "app_open" }));
    expect(forwardedHeaders(calls[0])["x-vercel-ip-country"]).toBeUndefined();
  });

  // the body is re-serialised, not streamed through, so a caller cannot
  // smuggle extra fields to the game server
  it("forwards only the event name, dropping anything else in the body", async () => {
    await POST(beacon({ name: "app_open", admin: true, ip: "1.2.3.4" }));
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ name: "app_open" });
  });

  it("never forwards a non-string name", async () => {
    await POST(beacon({ name: { evil: 1 } }));
    expect(calls).toHaveLength(0);
  });

  it("swallows malformed JSON instead of erroring", async () => {
    const req = new Request("https://app.test/api/events", { method: "POST", body: "not json" });
    await expect(POST(req)).resolves.toMatchObject({ status: 204 });
    expect(calls).toHaveLength(0);
  });

  // a beacon has nothing to do about a failure, and a non-2xx makes some
  // browsers retry against a server that is already down
  it("answers 204 even when the game server is unreachable", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));
    const res = await POST(beacon({ name: "app_open" }));
    expect(res.status).toBe(204);
  });
});
