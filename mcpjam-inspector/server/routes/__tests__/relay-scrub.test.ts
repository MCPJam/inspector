/**
 * The relay's credential backstop: what reaches PostHog through `/tlm` never
 * carries a credential URL, and a payload the relay cannot show to be clean
 * is dropped rather than forwarded (see "Credential scrubbing" in relay.ts).
 *
 * Every assertion here is on what the stubbed `fetch` was actually handed —
 * the bytes and the URL that would have left for PostHog — decoded the way
 * PostHog would decode them, so a test cannot pass by checking the wrong copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

const { relayEvent } = vi.hoisted(() => ({ relayEvent: vi.fn() }));

vi.mock("../../utils/request-logger.js", () => ({
  getSystemLogger: () => ({ event: relayEvent }),
}));

// The real registry, with a switch that makes its walker fail the way it does
// on a value it cannot finish.
const walkerControl = vi.hoisted(() => ({ fail: false }));

vi.mock("../../../shared/credential-urls.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../shared/credential-urls.js")>();
  return {
    ...actual,
    scrubTelemetryValue: (
      ...args: Parameters<typeof actual.scrubTelemetryValue>
    ) => {
      if (walkerControl.fail) {
        throw new actual.TelemetryScrubError("forced by the test");
      }
      return actual.scrubTelemetryValue(...args);
    },
  };
});

import relayRoutes, {
  RELAY_REPLAY_NESTED_MAX_BYTES,
  RELAY_SCRUB_MAX_TEXT_BYTES,
  flushRelayStats,
  relayBodyLimit,
} from "../relay.js";
import { POSTHOG_PROJECT_KEY } from "../../utils/analytics.js";

const ORIGINAL_FETCH = global.fetch;
const KEY = POSTHOG_PROJECT_KEY;
const OTHER_PROJECT_KEY = "phc_unrelated_project_key";

const SHARE_URL = "https://app.mcpjam.com/results/SENTINEL_tok_123";
const CALLBACK_URL =
  "https://app.mcpjam.com/oauth/callback?code=SENTINEL_code&state=SENTINEL_state";

function createTestApp() {
  const app = new Hono();
  app.use("/tlm/*", relayBodyLimit());
  app.route("/tlm", relayRoutes);
  return app;
}

function forwardedCall(): { url: URL; init: RequestInit } {
  expect(fetch).toHaveBeenCalledTimes(1);
  const [input, init] = vi.mocked(fetch).mock.calls[0];
  return { url: new URL(String(input)), init: init as RequestInit };
}

function forwardedBytes(): Buffer {
  const body = forwardedCall().init.body;
  expect(body).toBeDefined();
  return Buffer.from(body as Uint8Array);
}

/** The counters the next flush reports. */
function flushedStats(): Record<string, number> {
  relayEvent.mockClear();
  flushRelayStats();
  expect(relayEvent).toHaveBeenCalledTimes(1);
  expect(relayEvent.mock.calls[0][0]).toBe("relay.stats");
  return relayEvent.mock.calls[0][1] as Record<string, number>;
}

// An event batch the way posthog-js sends it, carrying a credential in the
// fields that hold the page URL — what the client is supposed to have
// scrubbed already, and the relay must catch when it has not.
function plantedBatch() {
  return {
    api_key: KEY,
    batch: [
      {
        event: "$pageview",
        $token: KEY,
        properties: {
          token: KEY,
          distinct_id: "device-1",
          $current_url: SHARE_URL,
          $pathname: "/results/SENTINEL_tok_123",
          $referrer: CALLBACK_URL,
          $elements_chain: 'a:href="/bench/results/SENTINEL_hex"',
          $set: { $initial_current_url: SHARE_URL },
          title: "Run results",
          count: 3,
        },
        timestamp: "2026-09-25T00:00:00.000Z",
      },
    ],
    sent_at: "2026-09-25T00:00:01.000Z",
  };
}

type Batch = ReturnType<typeof plantedBatch>;

// The event as PostHog should receive it: every credential gone, everything
// else exactly as it was, the project key included.
function expectScrubbed(payload: Batch) {
  expect(JSON.stringify(payload)).not.toContain("SENTINEL");
  expect(payload.api_key).toBe(KEY);
  expect(payload.sent_at).toBe("2026-09-25T00:00:01.000Z");
  expect(payload.batch).toHaveLength(1);
  const [event] = payload.batch;
  expect(event.event).toBe("$pageview");
  expect(event.$token).toBe(KEY);
  expect(event.timestamp).toBe("2026-09-25T00:00:00.000Z");
  expect(event.properties).toEqual({
    token: KEY,
    distinct_id: "device-1",
    $current_url: "https://app.mcpjam.com/results/[redacted]",
    $pathname: "/results/[redacted]",
    $referrer:
      "https://app.mcpjam.com/oauth/callback?code=[redacted]&state=[redacted]",
    $elements_chain: 'a:href="/bench/results/[redacted]"',
    $set: { $initial_current_url: "https://app.mcpjam.com/results/[redacted]" },
    title: "Run results",
    count: 3,
  });
}

/** A request body: fetch takes a string or a plain-ArrayBuffer view. */
function requestBody(body: string | Buffer): string | Uint8Array<ArrayBuffer> {
  return typeof body === "string" ? body : new Uint8Array(body);
}

function base64(json: string): string {
  return Buffer.from(json, "utf8").toString("base64");
}

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue(new Response("ok"));
  walkerControl.fail = false;
  // Start every test from zeroed counters.
  flushRelayStats();
  relayEvent.mockClear();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  walkerControl.fail = false;
});

describe("event payloads are scrubbed and re-encoded the way they came", () => {
  const json = () => JSON.stringify(plantedBatch());

  // [name, request body, decode the forwarded body back to the payload]
  const encodings: Array<
    [string, () => string | Buffer, (forwarded: Buffer) => unknown]
  > = [
    [
      "JSON",
      () => json(),
      (forwarded) => {
        expect(forwarded[0]).toBe("{".charCodeAt(0));
        return JSON.parse(forwarded.toString("utf8"));
      },
    ],
    [
      "gzip",
      () => gzipSync(json()),
      (forwarded) => {
        expect([forwarded[0], forwarded[1]]).toEqual([0x1f, 0x8b]);
        return JSON.parse(gunzipSync(forwarded).toString("utf8"));
      },
    ],
    [
      "form JSON",
      () => `data=${encodeURIComponent(json())}`,
      (forwarded) => {
        const form = new URLSearchParams(forwarded.toString("utf8"));
        expect([...form.keys()]).toEqual(["data"]);
        const data = form.get("data") as string;
        expect(data.startsWith("{")).toBe(true);
        return JSON.parse(data);
      },
    ],
    [
      "form base64",
      () => `data=${encodeURIComponent(base64(json()))}`,
      (forwarded) => {
        const form = new URLSearchParams(forwarded.toString("utf8"));
        expect([...form.keys()]).toEqual(["data"]);
        const data = form.get("data") as string;
        expect(data).toMatch(/^[A-Za-z0-9+/]+=*$/);
        return JSON.parse(Buffer.from(data, "base64").toString("utf8"));
      },
    ],
    [
      "gzip of a base64 form",
      () => gzipSync(`data=${encodeURIComponent(base64(json()))}`),
      (forwarded) => {
        expect([forwarded[0], forwarded[1]]).toEqual([0x1f, 0x8b]);
        const form = new URLSearchParams(
          gunzipSync(forwarded).toString("utf8"),
        );
        const data = form.get("data") as string;
        return JSON.parse(Buffer.from(data, "base64").toString("utf8"));
      },
    ],
  ];

  it.each(encodings)("%s body", async (_name, encode, decode) => {
    const body = encode();
    // Non-vacuous: the credential is really in what the client sent.
    const sent =
      typeof body === "string" ? body : gunzipSync(body).toString("utf8");
    expect(
      sent.includes("SENTINEL") ||
        Buffer.from(
          new URLSearchParams(sent).get("data") ?? "",
          "base64",
        ).includes("SENTINEL"),
    ).toBe(true);

    const response = await createTestApp().request(
      "/tlm/i/v0/e/?ip=1&ver=1.435.3",
      {
        method: "POST",
        body: requestBody(body),
        headers: { "content-length": String(Buffer.byteLength(body)) },
      },
    );

    expect(response.status).toBe(200);
    const { url, init } = forwardedCall();
    expect(url.href).toBe("https://us.i.posthog.com/i/v0/e/?ip=1&ver=1.435.3");
    // fetch() computes the new body's length; the client's is never sent on.
    expect(new Headers(init.headers).get("content-length")).toBeNull();
    const forwarded = forwardedBytes();
    expect(forwarded.includes("SENTINEL")).toBe(false);
    expectScrubbed(decode(forwarded) as Batch);
    expect(flushedStats()).toMatchObject({ scrubDrops: 0, res2xx: 1 });
  });

  it.each([
    ["JSON", (payload: string) => encodeURIComponent(payload)],
    ["base64", (payload: string) => encodeURIComponent(base64(payload))],
  ])("GET ?data= as %s, rewritten in the query", async (name, encode) => {
    const path = `/tlm/e/?ip=1&data=${encode(json())}&ver=1.435.3`;
    expect(decodeURIComponent(path)).toMatch(
      name === "JSON" ? /SENTINEL/ : /data=/,
    );

    const response = await createTestApp().request(path);

    expect(response.status).toBe(200);
    const { url, init } = forwardedCall();
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(url.href).not.toContain("SENTINEL");
    // The other parameters keep their place and spelling.
    expect([...url.searchParams.keys()]).toEqual(["ip", "data", "ver"]);
    expect(url.searchParams.get("ip")).toBe("1");
    expect(url.searchParams.get("ver")).toBe("1.435.3");
    const data = url.searchParams.get("data") as string;
    if (name === "JSON") {
      expect(data.startsWith("{")).toBe(true);
      expectScrubbed(JSON.parse(data));
    } else {
      expect(data).toMatch(/^[A-Za-z0-9+/]+=*$/);
      const decoded = Buffer.from(data, "base64").toString("utf8");
      expect(decoded).not.toContain("SENTINEL");
      expectScrubbed(JSON.parse(decoded));
    }
  });

  it("forwards no second ?data= alongside the scrubbed one", async () => {
    const clean = JSON.stringify({
      event: "$pageview",
      properties: { token: KEY },
    });
    const response = await createTestApp().request(
      `/tlm/e/?data=${encodeURIComponent(clean)}&data=${encodeURIComponent(
        JSON.stringify({ $current_url: SHARE_URL }),
      )}`,
    );
    expect(response.status).toBe(200);
    const { url } = forwardedCall();
    expect(url.searchParams.getAll("data")).toHaveLength(1);
    expect(url.href).not.toContain("SENTINEL");
  });

  it("scrubs the query parameters it forwards beside ?data=", async () => {
    const clean = JSON.stringify({
      event: "$pageview",
      properties: { token: KEY },
    });
    const response = await createTestApp().request(
      `/tlm/e/?data=${encodeURIComponent(clean)}&ver=1&redirect_uri=${encodeURIComponent(
        "https://user:SENTINEL_pw@example.com/x",
      )}&code=SENTINEL_code`,
    );
    expect(response.status).toBe(200);
    const { url } = forwardedCall();
    expect(url.href).not.toContain("SENTINEL");
    expect(url.searchParams.get("ver")).toBe("1");
    expect(url.searchParams.get("code")).toBe("[redacted]");
    expect(JSON.parse(url.searchParams.get("data") ?? "")).toEqual(
      JSON.parse(clean),
    );
  });

  it("forwards a project key in api_key as sent", async () => {
    const response = await createTestApp().request(
      `/tlm/i/v0/e/?ver=1&api_key=${KEY}`,
      { method: "POST", body: json() },
    );
    expect(response.status).toBe(200);
    const { url } = forwardedCall();
    expect(url.searchParams.get("api_key")).toBe(KEY);
  });

  it("drops a ?data= that a POST carries next to its body", async () => {
    const response = await createTestApp().request(
      `/tlm/i/v0/e/?ver=1&data=${encodeURIComponent(SHARE_URL)}`,
      { method: "POST", body: json() },
    );
    expect(response.status).toBe(200);
    const { url } = forwardedCall();
    expect(url.href).toBe("https://us.i.posthog.com/i/v0/e/?ver=1");
  });

  it.each([
    [
      "an event array",
      [
        {
          event: "$autocapture",
          properties: { token: KEY, $current_url: SHARE_URL },
        },
      ],
    ],
    [
      "a single event",
      {
        event: "$autocapture",
        properties: { token: KEY, $current_url: SHARE_URL },
      },
    ],
  ])("scrubs %s", async (_name, payload) => {
    const response = await createTestApp().request("/tlm/e/", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(200);
    const forwarded = JSON.parse(forwardedBytes().toString("utf8"));
    expect(forwarded).toEqual(
      JSON.parse(
        JSON.stringify(payload).replace(
          "results/SENTINEL_tok_123",
          "results/[redacted]",
        ),
      ),
    );
  });

  it("scrubs relative and protocol-relative URLs in event strings", async () => {
    const response = await createTestApp().request("/tlm/e/", {
      method: "POST",
      body: JSON.stringify({
        event: "custom",
        properties: {
          token: KEY,
          requested: "/api/test?co%64e=SENTINEL_enc",
          failure: "failed //user:SENTINEL_pw@example.com/path",
        },
      }),
    });
    expect(response.status).toBe(200);
    const forwarded = JSON.parse(forwardedBytes().toString("utf8"));
    expect(JSON.stringify(forwarded)).not.toContain("SENTINEL");
    expect(forwarded.properties.requested).toBe("/api/test?co%64e=[redacted]");
    expect(forwarded.properties.failure).toBe("failed //example.com/path");
  });

  it("scrubs object keys, which heatmap data is keyed by", async () => {
    const response = await createTestApp().request("/tlm/i/v0/e/", {
      method: "POST",
      body: JSON.stringify({
        event: "$$heatmap",
        properties: {
          token: KEY,
          $heatmap_data: { [SHARE_URL]: [{ x: 1, y: 2 }] },
        },
      }),
    });
    expect(response.status).toBe(200);
    const forwarded = JSON.parse(forwardedBytes().toString("utf8"));
    expect(forwarded.properties.$heatmap_data).toEqual({
      "https://app.mcpjam.com/results/[redacted]": [{ x: 1, y: 2 }],
    });
  });

  it("forwards a clean payload as the same JSON text", async () => {
    const clean = JSON.stringify({
      api_key: KEY,
      batch: [{ event: "$pageview", properties: { token: KEY, a: [1, "b"] } }],
      sent_at: "2026-09-25T00:00:00.000Z",
    });
    await createTestApp().request("/tlm/i/v0/e/", {
      method: "POST",
      body: clean,
    });
    expect(forwardedBytes().toString("utf8")).toBe(clean);
  });

  it("forwards a gzip batch that inflates past the 2 MiB body limit", async () => {
    // ~3 MB of text in a body under the 2 MiB limit.
    // Realistic compression (~2:1), not a zip bomb: the ratio guard is a
    // separate bound and stays in force.
    const stack = randomBytes(1_500_000).toString("hex");
    const payload = plantedBatch();
    const body = gzipSync(
      JSON.stringify({
        ...payload,
        batch: [
          {
            ...payload.batch[0],
            properties: { ...payload.batch[0].properties, stack },
          },
        ],
      }),
    );
    expect(body.length).toBeLessThan(2 * 1024 * 1024);
    const response = await createTestApp().request("/tlm/i/v0/e/", {
      method: "POST",
      body,
    });
    expect(response.status).not.toBe(400);
    const forwarded = gunzipSync(forwardedBytes()).toString("utf8");
    expect(forwarded).not.toContain("SENTINEL");
    expect(JSON.parse(forwarded).batch[0].properties.stack).toBe(stack);
  });

  it("still refuses another project before scrubbing", async () => {
    const payload = plantedBatch();
    payload.batch[0].properties.token = OTHER_PROJECT_KEY;
    const response = await createTestApp().request("/tlm/i/v0/e/", {
      method: "POST",
      body: gzipSync(JSON.stringify(payload)),
    });
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(flushedStats()).toMatchObject({ projectRejects: 1, scrubDrops: 0 });
  });
});

describe("event payloads that cannot be shown clean are dropped", () => {
  function deeplyNested(depth: number): unknown {
    let value: unknown = SHARE_URL;
    for (let i = 0; i < depth; i++) value = { inner: value };
    return value;
  }

  const validGzip = () => gzipSync(JSON.stringify(plantedBatch()));

  const cases: Array<[string, string, () => string | Buffer]> = [
    [
      "oversized once inflated",
      "/tlm/i/v0/e/",
      () =>
        gzipSync(
          JSON.stringify({
            event: "$pageview",
            properties: {
              token: KEY,
              $current_url: SHARE_URL,
              pad: "x".repeat(RELAY_SCRUB_MAX_TEXT_BYTES),
            },
          }),
        ),
    ],
    ["malformed JSON", "/tlm/i/v0/e/", () => `{"api_key":"${KEY}","batch":[`],
    [
      "malformed JSON in a form",
      "/tlm/e/",
      () => `data=${encodeURIComponent(`{"event":"${SHARE_URL}"`)}`,
    ],
    [
      "bad gzip",
      "/tlm/i/v0/e/",
      () => {
        // Valid header and trailer, corrupt deflate stream.
        const body = Buffer.from(validGzip());
        for (let i = 12; i < body.length - 8; i++) body[i] ^= 0x5a;
        return body;
      },
    ],
    ["a truncated gzip", "/tlm/i/v0/e/", () => validGzip().subarray(0, 12)],
    [
      "an unsupported encoding",
      "/tlm/i/v0/e/",
      () =>
        Buffer.concat([
          Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
          Buffer.from(SHARE_URL),
        ]),
    ],
    [
      "a form without a data field",
      "/tlm/i/v0/e/",
      () => `payload=${encodeURIComponent(JSON.stringify(plantedBatch()))}`,
    ],
    ["an empty body", "/tlm/i/v0/e/", () => ""],
    [
      "nesting the walker refuses",
      "/tlm/i/v0/e/",
      () =>
        JSON.stringify({
          event: "$pageview",
          properties: { token: KEY, deep: deeplyNested(80) },
        }),
    ],
    [
      "more values than the walker takes",
      "/tlm/i/v0/e/",
      () =>
        JSON.stringify({
          event: "$pageview",
          properties: {
            token: KEY,
            $current_url: SHARE_URL,
            many: new Array(210_000).fill(0),
          },
        }),
    ],
  ];

  it.each(cases)("%s", async (_name, path, build) => {
    const response = await createTestApp().request(path, {
      method: "POST",
      body: requestBody(build()),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "unreadable_payload" });
    expect(fetch).not.toHaveBeenCalled();
    expect(flushedStats()).toMatchObject({
      scrubDrops: 1,
      projectRejects: 0,
      res4xx: 1,
    });
  });

  it("drops a payload when the walker throws", async () => {
    walkerControl.fail = true;
    const response = await createTestApp().request("/tlm/i/v0/e/", {
      method: "POST",
      body: gzipSync(JSON.stringify(plantedBatch())),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "unreadable_payload" });
    expect(fetch).not.toHaveBeenCalled();
    expect(flushedStats()).toMatchObject({ scrubDrops: 1 });
  });

  it.each([
    ["no data", "/tlm/e/?ip=1"],
    ["malformed JSON", `/tlm/e/?data=${encodeURIComponent(`{"event":`)}`],
    ["malformed base64", "/tlm/e/?data=%%%not-base64"],
    [
      "nesting the walker refuses",
      `/tlm/e/?data=${encodeURIComponent(
        JSON.stringify({
          event: "x",
          properties: { token: KEY, d: deeplyNested(80) },
        }),
      )}`,
    ],
  ])("drops a GET with %s", async (_name, path) => {
    const response = await createTestApp().request(path);
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(flushedStats()).toMatchObject({ scrubDrops: 1 });
  });
});

describe("logs and metrics are scrubbed like events", () => {
  // OTLP JSON, which is what posthog-js sends to /i/v1/logs: the page URL is
  // an attribute, and the log body is free text.
  function otlpLogs() {
    return {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "web" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1700000000000000000",
                  body: { stringValue: `opened ${SHARE_URL}` },
                  attributes: [
                    { key: "currentUrl", value: { stringValue: CALLBACK_URL } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  it.each([
    ["JSON", (json: string) => json, (b: Buffer) => b.toString("utf8")],
    [
      "gzip",
      (json: string) => gzipSync(json),
      (b: Buffer) => gunzipSync(b).toString("utf8"),
    ],
    [
      "base64 form",
      (json: string) => `data=${encodeURIComponent(base64(json))}`,
      (b: Buffer) =>
        Buffer.from(
          new URLSearchParams(b.toString("utf8")).get("data") as string,
          "base64",
        ).toString("utf8"),
    ],
  ] as const)("%s", async (_name, encode, decode) => {
    for (const path of ["/i/v1/logs", "/i/v1/metrics"]) {
      vi.mocked(fetch).mockClear();
      const response = await createTestApp().request(
        `/tlm${path}?token=${KEY}`,
        { method: "POST", body: encode(JSON.stringify(otlpLogs())) },
      );
      expect(response.status).toBe(200);
      const { url } = forwardedCall();
      // The project key in the query is not touched.
      expect(url.searchParams.get("token")).toBe(KEY);
      const forwarded = JSON.parse(decode(forwardedBytes()));
      expect(JSON.stringify(forwarded)).not.toContain("SENTINEL");
      const record = forwarded.resourceLogs[0].scopeLogs[0].logRecords[0];
      expect(record.body.stringValue).toBe(
        "opened https://app.mcpjam.com/results/[redacted]",
      );
      expect(record.attributes[0].value.stringValue).toBe(
        "https://app.mcpjam.com/oauth/callback?code=[redacted]&state=[redacted]",
      );
      expect(record.timeUnixNano).toBe("1700000000000000000");
    }
  });

  it("drops a log payload that cannot be decoded", async () => {
    const response = await createTestApp().request(
      `/tlm/i/v1/logs?token=${KEY}`,
      { method: "POST", body: `{"resourceLogs":[` },
    );
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(flushedStats()).toMatchObject({ scrubDrops: 1 });
  });
});

// ---------------------------------------------------------------------------
// Replay. Built the way posthog-js builds a batch: `$snapshot` events whose
// `$snapshot_data` is a list of rrweb events, full snapshots and mutations
// packed as gzip-in-a-latin1-string (`cv: "2024-10"`).
// ---------------------------------------------------------------------------

function packed(value: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString(
    "latin1",
  );
}

function domWithLink(href: string, text = "Open") {
  return {
    type: 0,
    childNodes: [
      {
        type: 2,
        tagName: "html",
        attributes: {},
        childNodes: [
          {
            type: 2,
            tagName: "a",
            attributes: { href, class: "link" },
            childNodes: [{ type: 3, textContent: text, id: 4 }],
            id: 3,
          },
        ],
        id: 2,
      },
    ],
    id: 1,
  };
}

const meta = (href: string) => ({
  type: 4,
  data: { href, width: 1280, height: 720 },
  timestamp: 1,
});

const fullSnapshot = (node: unknown) => ({
  type: 2,
  data: packed({ node, initialOffset: { top: 0, left: 0 } }),
  timestamp: 2,
  cv: "2024-10",
});

const mutation = (
  fields: {
    texts?: unknown[];
    attributes?: unknown[];
    adds?: unknown[];
    removes?: unknown[];
  } = {},
) => ({
  type: 3,
  data: {
    source: 0,
    texts: packed(fields.texts ?? []),
    attributes: packed(fields.attributes ?? []),
    removes: packed(fields.removes ?? []),
    adds: packed(fields.adds ?? []),
  },
  timestamp: 3,
  cv: "2024-10",
});

const networkRequest = (name: string) => ({
  type: 6,
  data: {
    plugin: "rrweb/network@1",
    payload: {
      requests: [
        { name, initiatorType: "fetch", method: "GET", responseStatus: 200 },
      ],
    },
  },
  timestamp: 4,
});

const consoleLine = (line: string) => ({
  type: 6,
  data: {
    plugin: "rrweb/console@1",
    payload: { level: "log", payload: [JSON.stringify(line)], trace: [] },
  },
  timestamp: 5,
});

function cleanSnapshotData(): unknown[] {
  return [
    meta("https://app.mcpjam.com/projects/p1"),
    fullSnapshot(domWithLink("/projects/p1/servers")),
    mutation({
      texts: [{ id: 4, value: "Servers" }],
      attributes: [{ id: 3, attributes: { href: "/projects/p1/evals" } }],
      adds: [
        {
          parentId: 2,
          nextId: null,
          node: { type: 3, textContent: "hello", id: 9 },
        },
      ],
    }),
    networkRequest(
      "https://app.mcpjam.com/api/web/projects/p1?include=servers",
    ),
    consoleLine("loaded /projects/p1"),
  ];
}

function replayBatch(
  snapshotData: unknown[],
  properties: Record<string, unknown> = {},
  token = KEY,
): string {
  return JSON.stringify([
    {
      event: "$snapshot",
      properties: {
        token,
        distinct_id: "device-1",
        $session_id: "session-1",
        $window_id: "window-1",
        $snapshot_bytes: 1234,
        $snapshot_data: snapshotData,
        $current_url: "https://app.mcpjam.com/projects/p1",
        ...properties,
      },
    },
  ]);
}

const replayEncodings = [
  ["JSON", (json: string) => json],
  ["gzip", (json: string) => gzipSync(json)],
] as const;

describe.each(replayEncodings)("replay batches as %s", (_encoding, encode) => {
  it("forwards a clean batch byte for byte", async () => {
    const body = encode(replayBatch(cleanSnapshotData()));
    const response = await createTestApp().request("/tlm/s/?ver=1", {
      method: "POST",
      body,
    });
    expect(response.status).toBe(200);
    const { url } = forwardedCall();
    expect(url.href).toBe("https://us.i.posthog.com/s/?ver=1");
    expect(forwardedBytes().equals(Buffer.from(body))).toBe(true);
    expect(flushedStats()).toMatchObject({
      replayCredentialDrops: 0,
      replayUndecodableDrops: 0,
    });
  });

  const withCredential: Array<[string, () => string]> = [
    [
      "the meta event's href",
      () => replayBatch([meta(SHARE_URL), ...cleanSnapshotData()]),
    ],
    [
      "$current_url",
      () => replayBatch(cleanSnapshotData(), { $current_url: CALLBACK_URL }),
    ],
    [
      "a network request's URL",
      () =>
        replayBatch([
          ...cleanSnapshotData(),
          networkRequest(
            "https://app.mcpjam.com/api/web/score/runs/SENTINEL_tok_123",
          ),
        ]),
    ],
    [
      "a console line",
      () =>
        replayBatch([
          ...cleanSnapshotData(),
          consoleLine("redirecting to /oauth/callback?code=SENTINEL_code"),
        ]),
    ],
    [
      "a DOM attribute inside a full snapshot",
      () =>
        replayBatch([
          meta("https://app.mcpjam.com/projects/p1"),
          fullSnapshot(domWithLink("/conformance/shared/SENTINEL_tok")),
        ]),
    ],
    [
      "DOM text inside a full snapshot",
      () =>
        replayBatch([
          fullSnapshot(domWithLink("/projects/p1", `Share: ${SHARE_URL}`)),
        ]),
    ],
    [
      "a mutation's text",
      () =>
        replayBatch([
          mutation({ texts: [{ id: 4, value: `copy ${SHARE_URL}` }] }),
        ]),
    ],
    [
      "a mutation's attribute",
      () =>
        replayBatch([
          mutation({
            attributes: [
              {
                id: 3,
                attributes: { href: "/user-testing/s1/SENTINEL_tester" },
              },
            ],
          }),
        ]),
    ],
    [
      "a node a mutation adds",
      () =>
        replayBatch([
          mutation({
            adds: [
              {
                parentId: 2,
                nextId: null,
                node: domWithLink("/bench/results/SENTINEL_hex"),
              },
            ],
          }),
        ]),
    ],
    [
      "an object key",
      () =>
        replayBatch(cleanSnapshotData(), {
          $heatmap: { [SHARE_URL]: 1 },
        }),
    ],
  ];

  it.each(withCredential)(
    "accepts and drops a batch with a credential in %s",
    async (_name, build) => {
      const json = build();
      expect(
        json.includes("SENTINEL") ||
          // Inside nested gzip the text is compressed; check it decodes.
          json.includes("cv"),
      ).toBe(true);

      const response = await createTestApp().request("/tlm/s/", {
        method: "POST",
        body: encode(json),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 1 });
      expect(fetch).not.toHaveBeenCalled();
      expect(flushedStats()).toMatchObject({
        replayCredentialDrops: 1,
        replayUndecodableDrops: 0,
        res2xx: 1,
      });
    },
  );

  const undecodable: Array<[string, () => string]> = [
    [
      "nested gzip that is not gzip",
      () =>
        replayBatch([
          {
            type: 2,
            data: "\u001f\u008bnot really gzip",
            timestamp: 2,
            cv: "2024-10",
          },
        ]),
    ],
    [
      "nested gzip that is truncated",
      () =>
        replayBatch([
          {
            type: 2,
            data: packed({ node: domWithLink("/projects/p1") }).slice(0, 20),
            timestamp: 2,
            cv: "2024-10",
          },
        ]),
    ],
    [
      "nested gzip that is not JSON",
      () =>
        replayBatch([
          {
            type: 2,
            data: gzipSync("<html>not json</html>").toString("latin1"),
            timestamp: 2,
            cv: "2024-10",
          },
        ]),
    ],
    [
      "a nested string that is not a byte string",
      () =>
        replayBatch([
          {
            type: 2,
            data: `${packed({ node: domWithLink("/x") })}☃`,
            timestamp: 2,
            cv: "2024-10",
          },
        ]),
    ],
    [
      "gzip nested inside nested gzip",
      () =>
        replayBatch([
          {
            type: 2,
            data: packed({ inner: packed({ node: domWithLink("/x") }) }),
            timestamp: 2,
            cv: "2024-10",
          },
        ]),
    ],
  ];

  it.each(undecodable)(
    "accepts and drops a batch with %s",
    async (_name, build) => {
      const response = await createTestApp().request("/tlm/s/", {
        method: "POST",
        body: encode(build()),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 1 });
      expect(fetch).not.toHaveBeenCalled();
      expect(flushedStats()).toMatchObject({
        replayCredentialDrops: 0,
        replayUndecodableDrops: 1,
      });
    },
  );

  it("still refuses another project's batch, credential or not", async () => {
    const response = await createTestApp().request("/tlm/s/", {
      method: "POST",
      body: encode(replayBatch([meta(SHARE_URL)], {}, OTHER_PROJECT_KEY)),
    });
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(flushedStats()).toMatchObject({
      projectRejects: 1,
      replayCredentialDrops: 0,
    });
  });
});

describe("replay inspection bounds", () => {
  it("drops a batch whose nested data inflates past the batch's budget", async () => {
    // A string of zeros compresses about a thousandfold, so this is small to
    // send and over the budget to inflate.
    const huge = `[${"0,".repeat(RELAY_REPLAY_NESTED_MAX_BYTES / 2)}0]`;
    const nested = gzipSync(huge).toString("latin1");
    const response = await createTestApp().request("/tlm/s/", {
      method: "POST",
      body: gzipSync(
        replayBatch([{ type: 2, data: nested, timestamp: 2, cv: "2024-10" }]),
      ),
    });
    expect(response.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(flushedStats()).toMatchObject({ replayUndecodableDrops: 1 });
  });

  it("counts the budget across every nested string in the batch", async () => {
    // Each alone fits; together they do not.
    const third = `[${"0,".repeat(Math.ceil(RELAY_REPLAY_NESTED_MAX_BYTES / 6))}0]`;
    const nested = () => ({
      type: 2,
      data: gzipSync(third).toString("latin1"),
      timestamp: 2,
      cv: "2024-10",
    });
    const fits = await createTestApp().request("/tlm/s/", {
      method: "POST",
      body: gzipSync(replayBatch([nested()])),
    });
    expect(fits.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockClear();

    const over = await createTestApp().request("/tlm/s/", {
      method: "POST",
      body: gzipSync(replayBatch([nested(), nested(), nested(), nested()])),
    });
    expect(over.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("relay.stats", () => {
  it("reports the scrub counters and resets them on flush", async () => {
    const app = createTestApp();
    await app.request("/tlm/i/v0/e/", { method: "POST", body: "{" });
    await app.request("/tlm/s/", {
      method: "POST",
      body: replayBatch([meta(SHARE_URL)]),
    });
    await app.request("/tlm/s/", {
      method: "POST",
      body: replayBatch([
        { type: 2, data: "\u001f\u008bjunk", timestamp: 2, cv: "2024-10" },
      ]),
    });
    expect(flushedStats()).toMatchObject({
      requests: 3,
      scrubDrops: 1,
      replayCredentialDrops: 1,
      replayUndecodableDrops: 1,
      projectRejects: 0,
      res2xx: 2,
      res4xx: 1,
    });

    // A later interval starts from zero.
    await app.request("/tlm/i/v0/e/", { method: "POST", body: "{" });
    expect(flushedStats()).toMatchObject({
      scrubDrops: 1,
      replayCredentialDrops: 0,
      replayUndecodableDrops: 0,
    });
  });
});
