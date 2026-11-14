/**
 * The relay's credential pass (relay-credentials.ts), run inside the privacy
 * gate's rewrite (relay.ts): what reaches PostHog through `/tlm` never
 * carries a credential URL, at any policy, `full` included, and a payload
 * the relay cannot show to be clean is not forwarded.
 *
 * Events here are captured under a verified `full` context, so the privacy
 * gate leaves them as they are and every change is the credential pass's.
 * Every assertion is on what the stubbed `fetch` was actually handed, decoded
 * the way PostHog would decode it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
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

import relayRoutes, { flushRelayStats, relayBodyLimit } from "../relay.js";
import { RELAY_REPLAY_NESTED_MAX_BYTES } from "../relay-credentials.js";
import { POSTHOG_PROJECT_KEY } from "../../utils/analytics.js";
import { setTelemetryPolicyQueryForTests } from "../../services/telemetry-privacy-policy.js";
import {
  encodeCaptureContext,
  TELEMETRY_CONTEXT_PROPERTY,
} from "../../../shared/telemetry-privacy.js";

const ORIGINAL_FETCH = global.fetch;
const KEY = POSTHOG_PROJECT_KEY;
const OTHER_PROJECT_KEY = "phc_unrelated_project_key";
const BEARER = { Authorization: "Bearer relay-test-bearer", "x-mcpjam-telemetry-policy": "full" };
const FULL = { recording: "full", identity: "full", content: "full" } as const;
const FULL_STAMP = encodeCaptureContext({
  projectIds: [],
  organizationIds: ["org_public_00000000000000001"],
  policy: FULL,
});

const SHARE_URL = "https://app.mcpjam.com/results/SENTINEL_tok_123";
const CALLBACK_URL =
  "https://app.mcpjam.com/oauth/callback?code=SENTINEL_code&state=SENTINEL_state";

function createTestApp() {
  const app = new Hono();
  app.use("/tlm/*", relayBodyLimit());
  app.route("/tlm", relayRoutes);
  return app;
}

function post(path: string, body: string | Buffer) {
  return createTestApp().request(path, {
    method: "POST",
    body: typeof body === "string" ? body : new Uint8Array(body),
    headers: BEARER,
  });
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

interface CaptureEvent {
  event?: string;
  properties: Record<string, unknown>;
}

/** A capture body as PostHog receives it from the relay: gzip JSON. */
function forwardedJson(): unknown {
  return JSON.parse(gunzipSync(forwardedBytes()).toString("utf8"));
}

/** The events of a forwarded capture body, whatever its shape. */
function forwardedEvents(): CaptureEvent[] {
  const sent = forwardedJson() as CaptureEvent[] | { batch?: CaptureEvent[] };
  if (Array.isArray(sent)) return sent;
  return sent.batch ?? [sent as CaptureEvent];
}

/** The counters the next flush reports. */
function flushedStats(): Record<string, number> {
  relayEvent.mockClear();
  flushRelayStats();
  expect(relayEvent).toHaveBeenCalledTimes(1);
  expect(relayEvent.mock.calls[0][0]).toBe("relay.stats");
  return relayEvent.mock.calls[0][1] as Record<string, number>;
}

function base64(json: string): string {
  return Buffer.from(json, "utf8").toString("base64");
}

// An event batch the way posthog-js sends it, carrying a credential in the
// fields that hold the page URL: what the client is supposed to have
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
          [TELEMETRY_CONTEXT_PROPERTY]: FULL_STAMP,
        },
        timestamp: "2026-09-25T00:00:00.000Z",
      },
    ],
    sent_at: "2026-09-25T00:00:01.000Z",
  };
}

// The batch as PostHog should receive it: every credential gone, everything
// else as it was, the project key included (the gate removes the stamp).
function expectScrubbed(sent: unknown) {
  const payload = sent as ReturnType<typeof plantedBatch>;
  expect(JSON.stringify(payload)).not.toContain("SENTINEL");
  expect(payload.api_key).toBe(KEY);
  expect(payload.sent_at).toBe("2026-09-25T00:00:01.000Z");
  expect(payload.batch).toHaveLength(1);
  const [event] = payload.batch;
  expect(event.event).toBe("$pageview");
  expect(event.$token).toBe(KEY);
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

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue(new Response("ok"));
  walkerControl.fail = false;
  // Every context in these tests is verified non-private.
  setTelemetryPolicyQueryForTests(async () => ({ ...FULL }));
  // Start every test from zeroed counters.
  flushRelayStats();
  relayEvent.mockClear();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  walkerControl.fail = false;
  setTelemetryPolicyQueryForTests(null);
});

describe("event payloads lose their credentials at full", () => {
  const json = () => JSON.stringify(plantedBatch());

  it.each([
    ["JSON", () => json()],
    ["gzip", () => gzipSync(json())],
    ["form JSON", () => `data=${encodeURIComponent(json())}`],
    ["form base64", () => `data=${encodeURIComponent(base64(json()))}`],
    [
      "gzip of a base64 form",
      () => gzipSync(`data=${encodeURIComponent(base64(json()))}`),
    ],
  ] as const)("%s body", async (_name, encode) => {
    const response = await post("/tlm/i/v0/e/?ip=1&ver=1.435.3", encode());

    expect(response.status).toBe(200);
    const { url } = forwardedCall();
    expect(url.searchParams.get("ver")).toBe("1.435.3");
    expect(forwardedBytes().includes("SENTINEL")).toBe(false);
    expectScrubbed(forwardedJson());
    expect(flushedStats()).toMatchObject({ scrubDrops: 0, res2xx: 1 });
  });

  it.each([
    ["JSON", (payload: string) => encodeURIComponent(payload)],
    ["base64", (payload: string) => encodeURIComponent(base64(payload))],
  ])("GET ?data= as %s, rewritten in the query", async (_name, encode) => {
    const response = await createTestApp().request(
      `/tlm/e/?ip=1&data=${encode(json())}&ver=1.435.3`,
      { headers: BEARER },
    );

    expect(response.status).toBe(200);
    const { url, init } = forwardedCall();
    expect(init.body).toBeUndefined();
    expect(url.href).not.toContain("SENTINEL");
    expect(url.searchParams.get("ver")).toBe("1.435.3");
    expectScrubbed(JSON.parse(url.searchParams.get("data") as string));
  });

  it("scrubs the query parameters it forwards beside ?data=", async () => {
    const clean = JSON.stringify({
      event: "$pageview",
      properties: { token: KEY, [TELEMETRY_CONTEXT_PROPERTY]: FULL_STAMP },
    });
    const response = await createTestApp().request(
      `/tlm/e/?data=${encodeURIComponent(clean)}&ver=1&redirect_uri=${encodeURIComponent(
        "https://user:SENTINEL_pw@example.com/x",
      )}&code=SENTINEL_code&api_key=${KEY}`, { headers: BEARER },
    );
    expect(response.status).toBe(200);
    const { url } = forwardedCall();
    expect(url.href).not.toContain("SENTINEL");
    expect(url.searchParams.get("ver")).toBe("1");
    expect(url.searchParams.get("code")).toBe("[redacted]");
    // The project key is public, and pinned to ours: forwarded as sent.
    expect(url.searchParams.get("api_key")).toBe(KEY);
    expect(url.searchParams.getAll("data")).toHaveLength(1);
  });

  it("drops a ?data= that a POST carries next to its body", async () => {
    const response = await post(
      `/tlm/i/v0/e/?ver=1&data=${encodeURIComponent(SHARE_URL)}`,
      json(),
    );
    expect(response.status).toBe(200);
    const { url } = forwardedCall();
    expect(url.searchParams.has("data")).toBe(false);
    expect(url.href).not.toContain("SENTINEL");
  });

  it("scrubs relative and protocol-relative URLs in event strings", async () => {
    const response = await post(
      "/tlm/e/",
      JSON.stringify({
        event: "custom",
        properties: {
          token: KEY,
          requested: "/api/test?co%64e=SENTINEL_enc",
          failure: "failed //user:SENTINEL_pw@example.com/path",
          [TELEMETRY_CONTEXT_PROPERTY]: FULL_STAMP,
        },
      }),
    );
    expect(response.status).toBe(200);
    const [forwarded] = forwardedEvents();
    expect(JSON.stringify(forwarded)).not.toContain("SENTINEL");
    expect(forwarded.properties.requested).toBe("/api/test?co%64e=[redacted]");
    expect(forwarded.properties.failure).toBe("failed //example.com/path");
  });

  it("scrubs object keys, which heatmap data is keyed by", async () => {
    const response = await post(
      "/tlm/i/v0/e/",
      JSON.stringify({
        event: "$$heatmap",
        properties: {
          token: KEY,
          $heatmap_data: { [SHARE_URL]: [{ x: 1, y: 2 }] },
          [TELEMETRY_CONTEXT_PROPERTY]: FULL_STAMP,
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(forwardedEvents()[0].properties.$heatmap_data).toEqual({
      "https://app.mcpjam.com/results/[redacted]": [{ x: 1, y: 2 }],
    });
  });

  it("scrubs a request without a bearer too, on top of the conservative policy", async () => {
    const response = await createTestApp().request("/tlm/i/v0/e/", {
      method: "POST",
      body: json(),
    });
    expect(response.status).toBe(200);
    expect(forwardedBytes().includes("SENTINEL")).toBe(false);
  });

  it("still refuses another project before scrubbing", async () => {
    const payload = plantedBatch();
    payload.batch[0].properties.token = OTHER_PROJECT_KEY;
    const response = await post(
      "/tlm/i/v0/e/",
      gzipSync(JSON.stringify(payload)),
    );
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(flushedStats()).toMatchObject({ projectRejects: 1, scrubDrops: 0 });
  });
});

describe("events the walker cannot finish are not forwarded", () => {
  function deeplyNested(depth: number): unknown {
    let value: unknown = SHARE_URL;
    for (let i = 0; i < depth; i++) value = { inner: value };
    return value;
  }

  it.each([
    ["nesting it refuses", { deep: deeplyNested(80) }],
    ["more values than it takes", { many: new Array(210_000).fill(0) }],
  ])("drops a payload with %s", async (_name, extra) => {
    const response = await post(
      "/tlm/i/v0/e/",
      JSON.stringify({
        event: "$pageview",
        properties: {
          token: KEY,
          $current_url: SHARE_URL,
          [TELEMETRY_CONTEXT_PROPERTY]: FULL_STAMP,
          ...extra,
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "unreadable_payload" });
    expect(fetch).not.toHaveBeenCalled();
    expect(flushedStats()).toMatchObject({ scrubDrops: 1, projectRejects: 0 });
  });

  it("drops a payload when the walker throws", async () => {
    walkerControl.fail = true;
    const response = await post(
      "/tlm/i/v0/e/",
      gzipSync(JSON.stringify(plantedBatch())),
    );
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(flushedStats()).toMatchObject({ scrubDrops: 1 });
  });

  it("drops a GET the walker cannot finish", async () => {
    const response = await createTestApp().request(
      `/tlm/e/?data=${encodeURIComponent(
        JSON.stringify({
          event: "x",
          properties: {
            token: KEY,
            d: deeplyNested(80),
            [TELEMETRY_CONTEXT_PROPERTY]: FULL_STAMP,
          },
        }),
      )}`,
      { headers: BEARER },
    );
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(flushedStats()).toMatchObject({ scrubDrops: 1 });
  });
});

describe("unapproved OTLP families stop before vendor egress", () => {
  it.each([
    ["JSON", (json: string) => json],
    ["gzip", (json: string) => gzipSync(json)],
    [
      "base64 form",
      (json: string) => `data=${encodeURIComponent(base64(json))}`,
    ],
  ] as const)(
    "rejects %s metrics with arbitrary attributes",
    async (_name, encode) => {
      const response = await post(
        `/tlm/i/v1/metrics?token=${KEY}`,
        encode(
          JSON.stringify({
            resourceMetrics: [
              {
                resource: {
                  attributes: [
                    {
                      key: "prompt",
                      value: { stringValue: "SENTINEL_private_content" },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      );
      expect(response.status).toBe(403);
      expect(fetch).not.toHaveBeenCalled();
      expect(flushedStats()).toMatchObject({ privacyRejected: 1 });
    },
  );
  it("rejects logs and malformed metrics without decoding or forwarding", async () => {
    for (const family of ["logs", "metrics"]) {
      expect(
        (await post(`/tlm/i/v1/${family}?token=${KEY}`, "{invalid")).status,
      ).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Replay. Built the way posthog-js builds a batch: `$snapshot` events whose
// `$snapshot_data` is a list of rrweb events, full snapshots and mutations
// packed as gzip-in-a-latin1-string (`cv: "2024-10"`) by older clients.
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
        [TELEMETRY_CONTEXT_PROPERTY]: FULL_STAMP,
        ...properties,
      },
    },
  ]);
}

const replayEncodings = [
  ["JSON", (json: string) => json],
  ["gzip", (json: string) => gzipSync(json)],
] as const;

/** The `$snapshot` events PostHog was handed. */
function forwardedSnapshots(): CaptureEvent[] {
  return forwardedEvents().filter((event) => event.event === "$snapshot");
}

describe.each(replayEncodings)("replay batches as %s", (_encoding, encode) => {
  it("forwards a clean batch's recording unchanged", async () => {
    const data = cleanSnapshotData();
    const response = await post("/tlm/s/?ver=1", encode(replayBatch(data)));
    expect(response.status).toBe(200);
    const [snapshot] = forwardedSnapshots();
    expect(snapshot.properties.$snapshot_data).toEqual(data);
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
      "a DOM attribute inside a packed full snapshot",
      () =>
        replayBatch([
          meta("https://app.mcpjam.com/projects/p1"),
          fullSnapshot(domWithLink("/conformance/shared/SENTINEL_tok")),
        ]),
    ],
    [
      "DOM text inside a packed full snapshot",
      () =>
        replayBatch([
          fullSnapshot(domWithLink("/projects/p1", `Share: ${SHARE_URL}`)),
        ]),
    ],
    [
      "a packed mutation's text",
      () =>
        replayBatch([
          mutation({ texts: [{ id: 4, value: `copy ${SHARE_URL}` }] }),
        ]),
    ],
    [
      "a packed mutation's attribute",
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
      "an object key",
      () =>
        replayBatch(cleanSnapshotData(), {
          $heatmap: { [SHARE_URL]: 1 },
        }),
    ],
  ];

  it.each(withCredential)(
    "drops a replay event with a credential in %s and keeps the rest",
    async (_name, build) => {
      const replay = JSON.parse(build());
      const pageview = {
        event: "$pageview",
        properties: {
          token: KEY,
          [TELEMETRY_CONTEXT_PROPERTY]: FULL_STAMP,
        },
      };
      const response = await post(
        "/tlm/s/",
        encode(JSON.stringify([...replay, pageview])),
      );

      expect(response.status).toBe(200);
      expect(forwardedSnapshots()).toHaveLength(0);
      expect(forwardedBytes().includes("SENTINEL")).toBe(false);
      expect(flushedStats()).toMatchObject({
        replayCredentialDrops: 1,
        replayUndecodableDrops: 0,
      });
    },
  );

  it("answers a batch left with nothing to forward as restricted", async () => {
    const response = await post(
      "/tlm/s/",
      encode(replayBatch([meta(SHARE_URL)])),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "telemetry_restricted" });
    expect(fetch).not.toHaveBeenCalled();
  });

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

  it.each(undecodable)("drops a replay event with %s", async (_name, build) => {
    const response = await post("/tlm/s/", encode(build()));
    expect(fetch).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect(flushedStats()).toMatchObject({
      replayCredentialDrops: 0,
      replayUndecodableDrops: 1,
    });
  });

  it("still refuses another project's batch, credential or not", async () => {
    const response = await post(
      "/tlm/s/",
      encode(replayBatch([meta(SHARE_URL)], {}, OTHER_PROJECT_KEY)),
    );
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(flushedStats()).toMatchObject({
      projectRejects: 1,
      replayCredentialDrops: 0,
    });
  });
});

describe("replay inspection bounds", () => {
  it("drops a replay event whose nested data inflates past the budget", async () => {
    // A string of zeros compresses about a thousandfold, so this is small to
    // send and over the budget to inflate.
    const huge = `[${"0,".repeat(RELAY_REPLAY_NESTED_MAX_BYTES / 2)}0]`;
    const nested = gzipSync(huge).toString("latin1");
    const response = await post(
      "/tlm/s/",
      gzipSync(
        replayBatch([{ type: 2, data: nested, timestamp: 2, cv: "2024-10" }]),
      ),
    );
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(flushedStats()).toMatchObject({ replayUndecodableDrops: 1 });
  });

  it("counts the budget across every nested string in the request", async () => {
    // Each alone fits; together they do not.
    const third = `[${"0,".repeat(Math.ceil(RELAY_REPLAY_NESTED_MAX_BYTES / 6))}0]`;
    const nested = () => ({
      type: 2,
      data: gzipSync(third).toString("latin1"),
      timestamp: 2,
      cv: "2024-10",
    });
    const fits = await post("/tlm/s/", gzipSync(replayBatch([nested()])));
    expect(fits.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockClear();

    const over = await post(
      "/tlm/s/",
      gzipSync(replayBatch([nested(), nested(), nested(), nested()])),
    );
    expect(over.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("relay.stats", () => {
  it("reports the credential counters and resets them on flush", async () => {
    walkerControl.fail = true;
    await post("/tlm/i/v0/e/", JSON.stringify(plantedBatch()));
    walkerControl.fail = false;
    await post("/tlm/s/", replayBatch([meta(SHARE_URL)]));
    await post(
      "/tlm/s/",
      replayBatch([
        { type: 2, data: "\u001f\u008bjunk", timestamp: 2, cv: "2024-10" },
      ]),
    );
    expect(flushedStats()).toMatchObject({
      requests: 3,
      scrubDrops: 1,
      replayCredentialDrops: 1,
      replayUndecodableDrops: 1,
      projectRejects: 0,
    });

    // A later interval starts from zero.
    walkerControl.fail = true;
    await post("/tlm/i/v0/e/", JSON.stringify(plantedBatch()));
    expect(flushedStats()).toMatchObject({
      scrubDrops: 1,
      replayCredentialDrops: 0,
      replayUndecodableDrops: 0,
    });
  });
});
