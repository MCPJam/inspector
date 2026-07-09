import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import relayRoutes, { relayBodyLimit } from "../relay.js";
import { securityHeadersMiddleware } from "../../middleware/security-headers.js";
import { originValidationMiddleware } from "../../middleware/origin-validation.js";
import { sessionAuthMiddleware } from "../../middleware/session-auth.js";

const ORIGINAL_FETCH = global.fetch;

// Mount via app.route("/relay", ...) exactly like both production entries so
// the tests exercise the mounted-path behavior: inside the sub-app
// c.req.path still includes the /relay prefix, and the route must strip it
// before forwarding.
function createTestApp() {
  const app = new Hono();
  app.use("/relay/*", relayBodyLimit());
  app.route("/relay", relayRoutes);
  return app;
}

function upstreamResponse(
  body = "ok",
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(body, { status, headers });
}

function mockedFetchUrl(callIndex = 0): string {
  const call = vi.mocked(fetch).mock.calls[callIndex];
  const input = call[0];
  return input instanceof Request ? input.url : String(input);
}

function mockedFetchInit(callIndex = 0): RequestInit {
  return vi.mocked(fetch).mock.calls[callIndex][1] as RequestInit;
}

describe("posthog relay proxy", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it("forwards ingest POSTs with the /relay prefix stripped, preserving trailing slash, query, and body bytes", async () => {
    const app = createTestApp();
    vi.mocked(fetch).mockResolvedValueOnce(upstreamResponse());

    const payload = "compressed-event-batch";
    const res = await app.request(
      "http://localhost:6274/relay/i/v0/e/?compression=gzip-js&ip=1&ver=1.2.3",
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: payload,
      },
    );

    expect(res.status).toBe(200);
    expect(mockedFetchUrl()).toBe(
      "https://us.i.posthog.com/i/v0/e/?compression=gzip-js&ip=1&ver=1.2.3",
    );
    const init = mockedFetchInit();
    expect(init.method).toBe("POST");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(payload);
    expect(new Headers(init.headers).get("content-type")).toBe("text/plain");
  });

  it("routes /static and /array to the assets host and /flags to the ingest host", async () => {
    const app = createTestApp();
    vi.mocked(fetch).mockResolvedValue(upstreamResponse());

    await app.request("http://localhost:6274/relay/static/recorder.js");
    await app.request("http://localhost:6274/relay/array/phc_x/config.js");
    await app.request("http://localhost:6274/relay/flags/?v=2", {
      method: "POST",
      body: "{}",
    });

    expect(mockedFetchUrl(0)).toBe(
      "https://us-assets.i.posthog.com/static/recorder.js",
    );
    expect(mockedFetchUrl(1)).toBe(
      "https://us-assets.i.posthog.com/array/phc_x/config.js",
    );
    expect(mockedFetchUrl(2)).toBe("https://us.i.posthog.com/flags/?v=2");
  });

  it("strips cookie/host/session-auth headers and forwards the trusted client IP", async () => {
    const app = createTestApp();
    vi.mocked(fetch).mockResolvedValueOnce(upstreamResponse());

    await app.request("http://localhost:6274/relay/i/v0/e/", {
      method: "POST",
      body: "{}",
      headers: {
        Cookie: "mcpjam_session=secret",
        "X-MCP-Session-Auth": "token",
        "User-Agent": "test-agent",
        // Edge chain: first hop is the real client per client-ip.ts.
        "X-Forwarded-For": "1.2.3.4, 10.0.0.1",
      },
    });

    const headers = new Headers(mockedFetchInit().headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-mcp-session-auth")).toBeNull();
    expect(headers.get("host")).toBeNull();
    expect(headers.get("user-agent")).toBe("test-agent");
    expect(headers.get("x-forwarded-for")).toBe("1.2.3.4");
    expect(headers.get("x-real-ip")).toBe("1.2.3.4");
  });

  it("scrubs encoding/cookie/CORS headers from the upstream response and passes status through", async () => {
    const app = createTestApp();
    vi.mocked(fetch).mockResolvedValueOnce(
      upstreamResponse("too many", 429, {
        "content-encoding": "gzip",
        "content-length": "999",
        "set-cookie": "ph=1",
        "access-control-allow-origin": "*",
        "content-type": "application/json",
        "cache-control": "no-store",
      }),
    );

    const res = await app.request("http://localhost:6274/relay/i/v0/e/", {
      method: "POST",
      body: "{}",
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("too many");
  });

  it("returns 504 on upstream timeout and 502 on upstream network failure", async () => {
    const app = createTestApp();

    const timeoutError = new Error("timed out");
    timeoutError.name = "TimeoutError";
    vi.mocked(fetch).mockRejectedValueOnce(timeoutError);
    const timedOut = await app.request("http://localhost:6274/relay/i/v0/e/", {
      method: "POST",
      body: "{}",
    });
    expect(timedOut.status).toBe(504);

    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const failed = await app.request("http://localhost:6274/relay/i/v0/e/", {
      method: "POST",
      body: "{}",
    });
    expect(failed.status).toBe(502);
  });

  it("rejects >2MB bodies on event paths but accepts them on the session-recording path", async () => {
    const app = createTestApp();
    vi.mocked(fetch).mockResolvedValue(upstreamResponse());

    const threeMb = "x".repeat(3 * 1024 * 1024);

    const eventRes = await app.request("http://localhost:6274/relay/i/v0/e/", {
      method: "POST",
      body: threeMb,
    });
    expect(eventRes.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();

    const replayRes = await app.request("http://localhost:6274/relay/s/", {
      method: "POST",
      body: threeMb,
    });
    expect(replayRes.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockedFetchUrl()).toBe("https://us.i.posthog.com/s/");
  });

  it("passes the full security middleware stack without any session token", async () => {
    const app = new Hono();
    app.use("*", securityHeadersMiddleware);
    app.use("*", originValidationMiddleware);
    app.use("*", sessionAuthMiddleware);
    app.use("/relay/*", relayBodyLimit());
    app.route("/relay", relayRoutes);
    vi.mocked(fetch).mockResolvedValueOnce(upstreamResponse());

    const res = await app.request("http://localhost:6274/relay/i/v0/e/", {
      method: "POST",
      body: "{}",
      headers: { Origin: "http://localhost:6274" },
    });

    expect(res.status).toBe(200);
  });
});
