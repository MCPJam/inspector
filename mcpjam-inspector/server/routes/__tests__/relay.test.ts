import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import relayRoutes, {
  RELAY_BODY_READ_TIMEOUT_MS,
  RELAY_MAX_LARGE_PAYLOAD_CHECKS,
  RELAY_MAX_PAYLOAD_CHECKS,
  RELAY_PARSE_MAX_BYTES,
  relayBodyLimit,
  scanPayloadTokens,
} from "../relay.js";
import { POSTHOG_PROJECT_KEY } from "../../utils/analytics.js";
import { securityHeadersMiddleware } from "../../middleware/security-headers.js";
import { originValidationMiddleware } from "../../middleware/origin-validation.js";
import { sessionAuthMiddleware } from "../../middleware/session-auth.js";

// Lets a test hold gzip reads in flight; everything else is the real module.
const zlibControl = vi.hoisted(() => ({
  hold: false,
  held: [] as Array<() => void>,
}));

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  const gunzip = (...args: unknown[]) => {
    const run = () => Reflect.apply(actual.gunzip, actual, args);
    if (zlibControl.hold) zlibControl.held.push(run);
    else run();
  };
  return { ...actual, gunzip };
});

const ORIGINAL_FETCH = global.fetch;

const OTHER_PROJECT_KEY = "phc_unrelated_project_key";

// A capture body in the shape posthog-js sends: `{ api_key, batch, sent_at }`.
function eventBatch(token: string = POSTHOG_PROJECT_KEY): string {
  return JSON.stringify({
    api_key: token,
    batch: [
      { event: "$pageview", properties: { token, distinct_id: "device-1" } },
    ],
    sent_at: "2026-09-25T00:00:00.000Z",
  });
}

// The `data=` value of a base64-compressed request, URL-encoded.
function dataParam(json: string): string {
  return encodeURIComponent(Buffer.from(json).toString("base64"));
}

function base64Form(json: string): string {
  return `data=${dataParam(json)}`;
}

// A POST the way a browser sends it: with its body's declared length.
function sized(body: string | ReturnType<typeof gzipSync>): RequestInit {
  return {
    method: "POST",
    body,
    headers: { "content-length": String(Buffer.byteLength(body)) },
  };
}

// A replay batch whose snapshot data barely compresses.
function largeReplayBatch(snapshotBytes: number): string {
  return JSON.stringify([
    {
      event: "$snapshot",
      properties: {
        token: POSTHOG_PROJECT_KEY,
        $snapshot_data: randomBytes(snapshotBytes).toString("base64"),
      },
    },
  ]);
}

// Mount on BOTH prefixes exactly like both production entries so the tests
// exercise the mounted-path behavior: inside the sub-app c.req.path still
// includes the mount prefix (/relay or its edge-safe alias /tlm), and the
// route must strip whichever one it was reached through before forwarding.
function createTestApp() {
  const app = new Hono();
  app.use("/relay/*", relayBodyLimit());
  app.route("/relay", relayRoutes);
  app.use("/tlm/*", relayBodyLimit());
  app.route("/tlm", relayRoutes);
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
    zlibControl.hold = false;
    for (const run of zlibControl.held.splice(0)) run();
  });

  it("forwards ingest POSTs with the /relay prefix stripped, preserving trailing slash, query, and body bytes", async () => {
    const app = createTestApp();
    vi.mocked(fetch).mockResolvedValueOnce(upstreamResponse());

    const payload = eventBatch();
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

  it("serves the /tlm alias identically: prefix stripped, static/array/ingest routing intact", async () => {
    const app = createTestApp();
    vi.mocked(fetch).mockResolvedValue(upstreamResponse());

    await app.request("http://localhost:6274/tlm/static/recorder.js");
    await app.request(
      `http://localhost:6274/tlm/array/${POSTHOG_PROJECT_KEY}/config`,
    );
    await app.request("http://localhost:6274/tlm/i/v0/e/?compression=gzip-js", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: gzipSync(eventBatch()),
    });

    // PostHog must receive the bare subpaths — never /tlm/... — and the
    // remote-config path must hit the INGEST host (the assets host 403s our
    // production egress; see the routing comment in relay.ts).
    expect(mockedFetchUrl(0)).toBe(
      "https://us-assets.i.posthog.com/static/recorder.js",
    );
    expect(mockedFetchUrl(1)).toBe(
      `https://us.i.posthog.com/array/${POSTHOG_PROJECT_KEY}/config`,
    );
    expect(mockedFetchUrl(2)).toBe(
      "https://us.i.posthog.com/i/v0/e/?compression=gzip-js",
    );
  });

  it("routes /static to the assets host and /array to the ingest host", async () => {
    const app = createTestApp();
    vi.mocked(fetch).mockResolvedValue(upstreamResponse());

    await app.request("http://localhost:6274/relay/static/recorder.js");
    await app.request(
      `http://localhost:6274/relay/array/${POSTHOG_PROJECT_KEY}/config.js`,
    );

    expect(mockedFetchUrl(0)).toBe(
      "https://us-assets.i.posthog.com/static/recorder.js",
    );
    // Remote config deliberately targets the ingest host, matching what
    // posthog-js does unproxied — the assets host rejects our production
    // egress (relay.ts routing comment).
    expect(mockedFetchUrl(1)).toBe(
      `https://us.i.posthog.com/array/${POSTHOG_PROJECT_KEY}/config.js`,
    );
  });

  it.each([
    ["POST", "/flags/?v=2"],
    ["POST", "/flags"],
    ["POST", "/decide/?v=3"],
    ["GET", "/decide/?v=3"],
  ])("serves no feature-flag endpoint: %s %s", async (method, path) => {
    const response = await createTestApp().request(`/tlm${path}`, {
      method,
      ...(method === "POST"
        ? { body: JSON.stringify({ token: POSTHOG_PROJECT_KEY }) }
        : {}),
    });
    expect(response.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  describe.each(["/relay", "/tlm"])("%s request compatibility", (prefix) => {
    const key = POSTHOG_PROJECT_KEY;
    it.each([
      ["GET", `/e/?data=${dataParam(eventBatch())}`],
      ["POST", "/e/"],
      ["POST", "/i/v0/e/?compression=gzip-js"],
      ["POST", "/s/?compression=gzip-js"],
      ["POST", `/i/v1/logs?token=${key}`],
      ["POST", `/i/v1/metrics?token=${key}`],
      ["GET", `/array/${key}/config`],
      ["GET", `/array/${key}/config.js`],
      ["GET", "/static/recorder.js"],
      ["GET", "/static/1.369.0/recorder.js"],
      ["GET", "/static/1.434.12/surveys.js"],
      ["HEAD", "/static/array.js"],
      ["GET", `/api/surveys/?token=${key}`],
      ["GET", `/api/product_tours/?token=${key}`],
      ["GET", `/api/web_experiments/?token=${key}`],
      ["GET", `/api/early_access_features/?token=${key}`],
    ])("forwards %s %s", async (method, path) => {
      vi.mocked(fetch).mockResolvedValueOnce(upstreamResponse());
      const response = await createTestApp().request(`${prefix}${path}`, {
        method,
        ...(method === "POST" ? { body: eventBatch() } : {}),
      });
      expect(response.status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(1);
      const host = path.startsWith("/static/")
        ? "https://us-assets.i.posthog.com"
        : "https://us.i.posthog.com";
      expect(mockedFetchUrl()).toBe(`${host}${path}`);
      expect(mockedFetchInit().method).toBe(method);
    });

    it.each([
      ["GET", "/"],
      ["GET", "/api/projects/"],
      ["POST", "/api/surveys/"],
      ["DELETE", "/i/v0/e/"],
      ["PUT", "/flags/"],
      ["GET", "/flags/"],
      ["POST", "/flags/?v=2"],
      ["POST", "/decide/?v=3"],
      ["GET", "/decide/?v=3"],
      ["POST", "/s/unexpected"],
      ["POST", "/i/v0/e/extra"],
      ["GET", "/static/recorder.js/extra"],
      ["POST", "/static/recorder.js"],
      ["GET", "/static/%72ecorder.js"],
      ["GET", "/array/phc_example/config/extra"],
      ["GET", "/array/phc_example%2fother/config"],
      ["GET", "/api/surveys//"],
      ["GET", "/launch-engagement"],
    ])("declines %s %s without forwarding", async (method, path) => {
      const response = await createTestApp().request(`${prefix}${path}`, {
        method,
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it("strips cookie/host/session-auth headers and forwards the trusted client IP", async () => {
    const app = createTestApp();
    vi.mocked(fetch).mockResolvedValueOnce(upstreamResponse());

    await app.request("http://localhost:6274/relay/i/v0/e/", {
      method: "POST",
      body: eventBatch(),
      headers: {
        "x-mcpjam-edge-secret": "current",
        "x-mcpjam-edge-secret-previous": "previous",
        "cf-ray": "test-ray",
        "x-inspector-service-token": "service",
        Cookie: "mcpjam_session=secret",
        "X-MCP-Session-Auth": "token",
        "User-Agent": "test-agent",
        // Edge chain: first hop is the real client per client-ip.ts.
        "X-Forwarded-For": "1.2.3.4, 10.0.0.1",
      },
    });

    const headers = new Headers(mockedFetchInit().headers);
    for (const name of [
      "x-mcpjam-edge-secret",
      "x-mcpjam-edge-secret-previous",
      "cf-connecting-ip",
      "cf-ray",
      "x-inspector-service-token",
    ])
      expect(headers.get(name)).toBeNull();
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
      body: eventBatch(),
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
      body: eventBatch(),
    });
    expect(timedOut.status).toBe(504);

    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const failed = await app.request("http://localhost:6274/relay/i/v0/e/", {
      method: "POST",
      body: eventBatch(),
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
    expect(await eventRes.json()).toEqual({ error: "payload_too_large" });
    expect(fetch).not.toHaveBeenCalled();

    const replayRes = await app.request("http://localhost:6274/relay/s/", {
      method: "POST",
      body: JSON.stringify([
        {
          event: "$snapshot",
          properties: { token: POSTHOG_PROJECT_KEY, $snapshot_data: threeMb },
        },
      ]),
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
      body: eventBatch(),
      headers: { Origin: "http://localhost:6274" },
    });

    expect(res.status).toBe(200);
  });

  describe("project pinning", () => {
    const encodings: Array<
      [string, (token: string) => string | ReturnType<typeof gzipSync>]
    > = [
      ["JSON batch", (token) => eventBatch(token)],
      ["gzip batch", (token) => gzipSync(eventBatch(token))],
      ["base64 form body", (token) => base64Form(eventBatch(token))],
      [
        "event array",
        (token) =>
          JSON.stringify([{ event: "$pageview", properties: { token } }]),
      ],
      [
        "single event",
        (token) =>
          JSON.stringify({ event: "$pageview", properties: { token } }),
      ],
    ];

    it.each(encodings)(
      "forwards a %s for our project byte for byte",
      async (_name, encode) => {
        vi.mocked(fetch).mockResolvedValueOnce(upstreamResponse());
        const body = encode(POSTHOG_PROJECT_KEY);

        const response = await createTestApp().request("/tlm/i/v0/e/", {
          method: "POST",
          body,
        });

        expect(response.status).toBe(200);
        expect(
          Buffer.from(mockedFetchInit().body as ArrayBuffer).equals(
            typeof body === "string" ? Buffer.from(body) : body,
          ),
        ).toBe(true);
      },
    );

    it.each(encodings)(
      "refuses a %s for another project",
      async (_name, encode) => {
        const response = await createTestApp().request("/tlm/i/v0/e/", {
          method: "POST",
          body: encode(OTHER_PROJECT_KEY),
        });

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: "unsupported_project",
        });
        expect(fetch).not.toHaveBeenCalled();
      },
    );

    it("refuses a batch that names a second project", async () => {
      const response = await createTestApp().request("/tlm/s/", {
        method: "POST",
        body: gzipSync(
          JSON.stringify([
            { event: "$snapshot", properties: { token: POSTHOG_PROJECT_KEY } },
            { event: "$snapshot", properties: { token: OTHER_PROJECT_KEY } },
          ]),
        ),
      });

      expect(response.status).toBe(403);
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
      ["GET", `/array/${OTHER_PROJECT_KEY}/config.js`],
      ["GET", `/api/surveys/?token=${OTHER_PROJECT_KEY}`],
      ["GET", `/api/early_access_features/?token=${OTHER_PROJECT_KEY}`],
      ["POST", `/i/v1/logs?token=${OTHER_PROJECT_KEY}`],
      ["POST", `/i/v1/metrics?token=${OTHER_PROJECT_KEY}`],
      ["POST", `/i/v0/e/?token=${OTHER_PROJECT_KEY}`],
      ["GET", `/e/?data=${dataParam(eventBatch(OTHER_PROJECT_KEY))}`],
    ])("refuses %s %s", async (method, path) => {
      const response = await createTestApp().request(`/tlm${path}`, {
        method,
        ...(method === "POST" ? { body: eventBatch() } : {}),
      });

      expect(response.status).toBe(403);
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
      ["POST", "/i/v0/e/", "opaque-sdk-payload"],
      ["POST", "/i/v0/e/", "{}"],
      ["POST", "/i/v0/e/", "[]"],
      ["POST", "/s/", "data=%%%"],
      ["POST", "/s/", Buffer.from([0x1f, 0x8b, 0x00, 0x01])],
      ["POST", "/i/v1/logs", "{}"],
      ["GET", "/e/", undefined],
      ["GET", "/api/surveys/", undefined],
    ])(
      "refuses %s %s when its project cannot be read",
      async (method, path, body) => {
        const response = await createTestApp().request(`/tlm${path}`, {
          method,
          ...(body !== undefined ? { body } : {}),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "unreadable_payload" });
        expect(fetch).not.toHaveBeenCalled();
      },
    );
  });

  describe("capture payload reads", () => {
    it.each(["/i/v0/e/", "/s/"])(
      "refuses a small gzip body on %s that inflates past its budget",
      async (path) => {
        // Whitespace compresses about a thousandfold.
        const body = gzipSync(`${" ".repeat(3 * 1024 * 1024)}${eventBatch()}`);
        expect(body.length).toBeLessThan(64 * 1024);

        const response = await createTestApp().request(`/tlm${path}`, {
          method: "POST",
          body,
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "unreadable_payload" });
        expect(fetch).not.toHaveBeenCalled();
      },
    );

    it("forwards a large gzip replay batch that stays within its ratio", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(upstreamResponse());
      const body = gzipSync(largeReplayBatch(2 * 1024 * 1024));

      const response = await createTestApp().request("/tlm/s/", {
        method: "POST",
        body,
      });

      expect(response.status).toBe(200);
      expect(
        Buffer.from(mockedFetchInit().body as ArrayBuffer).equals(body),
      ).toBe(true);
    });

    it("answers 503 for a large payload while others are being read", async () => {
      vi.mocked(fetch).mockResolvedValue(upstreamResponse());
      const app = createTestApp();
      const body = gzipSync(largeReplayBatch(2 * 1024 * 1024));
      zlibControl.hold = true;

      const pending = Array.from(
        { length: RELAY_MAX_LARGE_PAYLOAD_CHECKS },
        () => app.request("/tlm/s/", sized(body)),
      );
      await vi.waitFor(() =>
        expect(zlibControl.held).toHaveLength(RELAY_MAX_LARGE_PAYLOAD_CHECKS),
      );

      const refused = await app.request("/tlm/s/", sized(body));
      expect(refused.status).toBe(503);
      expect(refused.headers.get("retry-after")).toBe("1");
      expect(await refused.json()).toEqual({ error: "relay_busy" });

      const small = await app.request("/tlm/i/v0/e/", sized(eventBatch()));
      expect(small.status).toBe(200);

      zlibControl.hold = false;
      for (const run of zlibControl.held.splice(0)) run();
      for (const response of await Promise.all(pending)) {
        expect(response.status).toBe(200);
      }

      const after = await app.request("/tlm/s/", sized(body));
      expect(after.status).toBe(200);
    });

    it("answers 503 once the payloads being read fill every slot, small ones included", async () => {
      vi.mocked(fetch).mockResolvedValue(upstreamResponse());
      const app = createTestApp();
      const body = gzipSync(eventBatch());
      zlibControl.hold = true;

      const pending = Array.from({ length: RELAY_MAX_PAYLOAD_CHECKS }, () =>
        app.request("/tlm/i/v0/e/", sized(body)),
      );
      await vi.waitFor(() =>
        expect(zlibControl.held).toHaveLength(RELAY_MAX_PAYLOAD_CHECKS),
      );

      const refused = await app.request("/tlm/i/v0/e/", sized(body));
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual({ error: "relay_busy" });

      zlibControl.hold = false;
      for (const run of zlibControl.held.splice(0)) run();
      for (const response of await Promise.all(pending)) {
        expect(response.status).toBe(200);
      }
    });

    it("classifies a replay batch by its inflated size, not its compressed size", async () => {
      vi.mocked(fetch).mockResolvedValue(upstreamResponse());
      const app = createTestApp();
      const large = gzipSync(largeReplayBatch(2 * 1024 * 1024));
      zlibControl.hold = true;
      const pending = Array.from(
        { length: RELAY_MAX_LARGE_PAYLOAD_CHECKS },
        () => app.request("/tlm/s/", sized(large)),
      );
      await vi.waitFor(() =>
        expect(zlibControl.held).toHaveLength(RELAY_MAX_LARGE_PAYLOAD_CHECKS),
      );
      zlibControl.hold = false;

      // Well over 64 KiB compressed, well under the floor once inflated.
      const replay = gzipSync(largeReplayBatch(256 * 1024));
      expect(replay.length).toBeGreaterThan(64 * 1024);
      const response = await app.request("/tlm/s/", sized(replay));
      expect(response.status).toBe(200);

      for (const run of zlibControl.held.splice(0)) run();
      await Promise.all(pending);
    });

    it("refuses a gzip body that holds more than its trailer declares", async () => {
      const body = Buffer.from(gzipSync(eventBatch()));
      body.writeUInt32LE(8, body.length - 4);

      const response = await createTestApp().request("/tlm/i/v0/e/", {
        method: "POST",
        body,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "unreadable_payload" });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe("body read deadline", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // A body that declares its length and never finishes arriving.
    function stalledRequest(path: string): Request {
      return new Request(`http://localhost:6274${path}`, {
        method: "POST",
        body: new ReadableStream({ start() {} }),
        headers: { "content-length": "1000" },
        duplex: "half",
      } as RequestInit);
    }

    it("answers 408 for a stalled body, which never holds an admission slot", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.mocked(fetch).mockResolvedValue(upstreamResponse());
      const app = createTestApp();

      const stalled = [
        ...Array.from({ length: RELAY_MAX_PAYLOAD_CHECKS }, () =>
          app.request(stalledRequest("/tlm/i/v0/e/")),
        ),
        ...Array.from({ length: RELAY_MAX_LARGE_PAYLOAD_CHECKS }, () =>
          app.request(stalledRequest("/tlm/s/")),
        ),
      ];

      // Every kind of capture request is still served meanwhile.
      const small = await app.request("/tlm/i/v0/e/", sized(eventBatch()));
      expect(small.status).toBe(200);
      const gzipped = await app.request(
        "/tlm/i/v0/e/",
        sized(gzipSync(eventBatch())),
      );
      expect(gzipped.status).toBe(200);
      const replay = await app.request(
        "/tlm/s/",
        sized(gzipSync(largeReplayBatch(2 * 1024 * 1024))),
      );
      expect(replay.status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(RELAY_BODY_READ_TIMEOUT_MS);
      for (const response of await Promise.all(stalled)) {
        expect(response.status).toBe(408);
        expect(response.headers.get("connection")).toBe("close");
        expect(await response.json()).toEqual({ error: "relay_body_timeout" });
      }
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("does not time out a body that arrives before the deadline", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.mocked(fetch).mockResolvedValue(upstreamResponse());
      const bytes = Buffer.from(eventBatch());
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const pending = createTestApp().request(
        new Request("http://localhost:6274/tlm/i/v0/e/", {
          method: "POST",
          body: new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
            },
          }),
          headers: { "content-length": String(bytes.length) },
          duplex: "half",
        } as RequestInit),
      );

      await vi.advanceTimersByTimeAsync(RELAY_BODY_READ_TIMEOUT_MS - 1);
      controller.enqueue(new Uint8Array(bytes));
      controller.close();

      const response = await pending;
      expect(response.status).toBe(200);
      expect(
        Buffer.from(mockedFetchInit().body as ArrayBuffer).equals(bytes),
      ).toBe(true);
    });
  });

  describe("large payload reads", () => {
    // Pads a payload past the size that is parsed outright, the way a replay
    // batch's snapshot data does: a large value on each event.
    function padded(events: Array<Record<string, unknown>>) {
      return events.map((event) => ({
        ...event,
        properties: {
          ...(event.properties as Record<string, unknown>),
          $snapshot_data: [
            {
              type: 2,
              data: { token: OTHER_PROJECT_KEY, blob: "x".repeat(96 * 1024) },
            },
          ],
        },
      }));
    }

    const ours = POSTHOG_PROJECT_KEY;
    const other = OTHER_PROJECT_KEY;

    // [name, payload builder, expected status]. Each payload is sent both as
    // it is and padded past RELAY_PARSE_MAX_BYTES.
    const cases: Array<
      [string, (pad: typeof padded) => unknown, 200 | 400 | 403]
    > = [
      [
        "an event array for our project",
        (pad) => pad([{ event: "$snapshot", properties: { token: ours } }]),
        200,
      ],
      [
        "a batch for our project",
        (pad) => ({
          api_key: ours,
          batch: pad([{ event: "$pageview", properties: { token: ours } }]),
        }),
        200,
      ],
      [
        "an event array naming another project",
        (pad) => pad([{ event: "$snapshot", properties: { token: other } }]),
        403,
      ],
      [
        "a batch whose last event names another project",
        (pad) => ({
          api_key: ours,
          batch: pad([
            { event: "$pageview", properties: { token: ours } },
            { event: "$pageview", properties: { token: ours } },
            { event: "$pageview", properties: { token: other } },
          ]),
        }),
        403,
      ],
      [
        "a batch whose envelope names another project",
        (pad) => ({
          api_key: other,
          batch: pad([{ event: "$pageview", properties: { token: ours } }]),
        }),
        403,
      ],
      [
        "a batch with another project's envelope properties",
        (pad) => ({
          properties: { token: other },
          batch: pad([{ event: "$pageview", properties: { token: ours } }]),
        }),
        403,
      ],
      [
        "an event with another project in $token",
        (pad) =>
          pad([
            { event: "$snapshot", $token: other, properties: { token: ours } },
          ]),
        403,
      ],
      [
        "an event whose token is not a string",
        (pad) =>
          pad([{ event: "$snapshot", properties: { token: { value: ours } } }]),
        403,
      ],
      [
        "a single event object for another project",
        (pad) => pad([{ event: "$snapshot", properties: { token: other } }])[0],
        403,
      ],
      [
        "an event array without a token",
        (pad) => pad([{ event: "$snapshot", properties: {} }]),
        400,
      ],
    ];

    describe.each([
      ["JSON", (json: string) => json],
      ["gzip", (json: string) => gzipSync(json)],
      ["base64 form", (json: string) => base64Form(json)],
    ] as const)("%s", (_encoding, encode) => {
      it.each(cases)("%s", async (_name, build, status) => {
        vi.mocked(fetch).mockResolvedValue(upstreamResponse());
        const app = createTestApp();
        const small = JSON.stringify(build((events) => events));
        const large = JSON.stringify(build(padded));
        expect(small.length).toBeLessThan(RELAY_PARSE_MAX_BYTES);
        expect(large.length).toBeGreaterThan(RELAY_PARSE_MAX_BYTES);

        for (const json of [small, large]) {
          const response = await app.request("/tlm/s/", {
            method: "POST",
            body: encode(json),
          });
          expect(response.status).toBe(status);
        }
        expect(fetch).toHaveBeenCalledTimes(status === 200 ? 2 : 0);
      });
    });

    it("reads a large payload without parsing it whole", async () => {
      vi.mocked(fetch).mockResolvedValue(upstreamResponse());
      const parse = vi.spyOn(JSON, "parse");
      try {
        const body = gzipSync(largeReplayBatch(3 * 1024 * 1024));
        const response = await createTestApp().request("/tlm/s/", {
          method: "POST",
          body,
        });
        expect(response.status).toBe(200);
        for (const [text] of parse.mock.calls) {
          expect(String(text).length).toBeLessThanOrEqual(
            RELAY_PARSE_MAX_BYTES,
          );
        }
      } finally {
        parse.mockRestore();
      }
    });

    it("yields to the event loop while scanning", async () => {
      const json = Buffer.from(
        JSON.stringify(
          Array.from({ length: 20_000 }, (_, i) => ({
            event: "$snapshot",
            properties: { token: POSTHOG_PROJECT_KEY, x: i, y: [i, i] },
          })),
        ),
      );
      const order: string[] = [];
      setImmediate(() => order.push("other work"));
      await scanPayloadTokens(json, []).then(() => order.push("scan"));
      expect(order).toEqual(["other work", "scan"]);
    });

    it.each([
      [
        "a plain event",
        `[{"event":"x","properties":{"token":"${POSTHOG_PROJECT_KEY}"}}]`,
        [POSTHOG_PROJECT_KEY],
      ],
      [
        "an escaped key",
        `[{"properties":{"\\u0074oken":"${OTHER_PROJECT_KEY}"}}]`,
        [OTHER_PROJECT_KEY],
      ],
      [
        "an escaped value",
        `[{"properties":{"token":"\\u0070${POSTHOG_PROJECT_KEY.slice(1)}"}}]`,
        [POSTHOG_PROJECT_KEY],
      ],
      [
        "a repeated key",
        `{"api_key":"${OTHER_PROJECT_KEY}","api_key":"${POSTHOG_PROJECT_KEY}"}`,
        [OTHER_PROJECT_KEY, POSTHOG_PROJECT_KEY],
      ],
      [
        "a token inside a string",
        `[{"properties":{"$snapshot_data":"{\\"token\\":\\"${OTHER_PROJECT_KEY}\\"}"}}]`,
        [],
      ],
      [
        "a token below the event",
        `[{"properties":{"$snapshot_data":[{"token":"${OTHER_PROJECT_KEY}"}]}}]`,
        [],
      ],
      [
        "a token on a nested batch",
        `{"batch":[{"batch":[{"token":"${OTHER_PROJECT_KEY}"}]}]}`,
        [],
      ],
      [
        "a numeric token",
        `{"batch":[{"api_key":12}],"token":null}`,
        [null, null],
      ],
    ])("scans %s", async (_name, json, expected) => {
      const tokens: unknown[] = [];
      await scanPayloadTokens(Buffer.from(json), tokens);
      expect(tokens).toEqual(expected);
    });

    it.each([
      ["truncated JSON", `[{"properties":{"token":"${POSTHOG_PROJECT_KEY}"}}`],
      [
        "an unterminated string",
        `[{"properties":{"token":"${POSTHOG_PROJECT_KEY}`,
      ],
      [
        "trailing data",
        `[{"properties":{"token":"${POSTHOG_PROJECT_KEY}"}}] []`,
      ],
      ["a missing colon", `[{"properties" {"token":"x"}}]`],
      ["a missing comma", `[{"a":1 "b":2}]`],
      ["a mismatched bracket", `[{"a":1]}`],
      ["a bad literal", `[{"a":nul}]`],
      ["an empty payload", `   `],
    ])("refuses to scan %s", async (_name, json) => {
      await expect(scanPayloadTokens(Buffer.from(json), [])).rejects.toThrow();
    });
  });
});
