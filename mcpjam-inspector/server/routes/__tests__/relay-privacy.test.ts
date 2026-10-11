import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { gunzipSync, gzipSync } from "node:zlib";

// The relay's aggregate counters go out through the system logger; capture
// them so the privacy counts can be asserted.
const loggedEvents = vi.hoisted(
  () => [] as Array<{ name: string; fields: Record<string, number> }>,
);
vi.mock("../../utils/request-logger.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/request-logger.js")>();
  return {
    ...actual,
    getSystemLogger: (component: string) => {
      const logger = actual.getSystemLogger(component);
      return {
        ...logger,
        event: (name: string, fields: Record<string, number>) => {
          loggedEvents.push({ name, fields });
        },
      };
    },
  };
});

import relayRoutes, {
  flushRelayStats,
  RELAY_MAX_PAYLOAD_CHECKS,
  RELAY_MAX_POLICY_WAITS,
  relayBodyLimit,
} from "../relay.js";
import { POSTHOG_PROJECT_KEY } from "../../utils/analytics.js";
import { setTelemetryPolicyQueryForTests } from "../../services/telemetry-privacy-policy.js";
import {
  encodeCaptureContext,
  mostRestrictivePolicy,
  TELEMETRY_CONTEXT_PROPERTY,
  type TelemetryPolicy,
} from "../../../shared/telemetry-privacy.js";
import {
  CREDENTIAL_PATH_PREFIXES,
  scrubSensitiveUrl,
} from "../../../shared/credential-url.js";
import {
  findSyntheticPii,
  SYNTHETIC_PII,
} from "../../../shared/__tests__/fixtures/telemetry-pii.js";

const ORIGINAL_FETCH = global.fetch;
const TOKEN = "relay-bearer-token";
const FULL: TelemetryPolicy = { recording: "full", identity: "full" };
const MASKED: TelemetryPolicy = { recording: "masked", identity: "id_only" };
const OFF: TelemetryPolicy = { recording: "off", identity: "id_only" };

const PUBLIC_ORG = "org_public_00000000000000001";
const PRIVATE_ORG = "org_private_0000000000000001";

function createTestApp() {
  const app = new Hono();
  for (const prefix of ["/relay", "/tlm"]) {
    app.use(`${prefix}/*`, relayBodyLimit());
    app.route(prefix, relayRoutes);
  }
  return app;
}

/** The backend, answering per organization in view. */
function backend(answers: Record<string, TelemetryPolicy>) {
  const calls: Array<{ token: string; organizationIds: string[] }> = [];
  setTelemetryPolicyQueryForTests(async (_url, token, context) => {
    calls.push({ token, organizationIds: context.organizationIds });
    const policies = context.organizationIds.map((id) => answers[id] ?? MASKED);
    return policies.length > 0 ? mostRestrictivePolicy(...policies) : MASKED;
  });
  return calls;
}

function stamp(organizationIds: string[], policy: TelemetryPolicy = FULL) {
  return encodeCaptureContext({ projectIds: [], organizationIds, policy });
}

// ── rrweb fixtures carrying synthetic personal data ──────────────────────

function pageNode() {
  return {
    type: 0,
    id: 1,
    childNodes: [
      { type: 1, id: 2, name: "html", publicId: "", systemId: "" },
      {
        type: 2,
        id: 3,
        tagName: "html",
        attributes: { lang: "en" },
        childNodes: [
          {
            type: 2,
            id: 4,
            tagName: "head",
            attributes: {},
            childNodes: [
              {
                type: 2,
                id: 5,
                tagName: "style",
                attributes: {},
                childNodes: [
                  {
                    type: 3,
                    id: 6,
                    textContent: ".row { color: red; }",
                    isStyle: true,
                  },
                ],
              },
            ],
          },
          {
            type: 2,
            id: 7,
            tagName: "body",
            attributes: { class: "app" },
            childNodes: [
              {
                type: 2,
                id: 8,
                tagName: "h1",
                attributes: {
                  class: "title",
                  title: SYNTHETIC_PII.title,
                  "data-state": "open",
                },
                childNodes: [
                  { type: 3, id: 9, textContent: SYNTHETIC_PII.domText },
                ],
              },
              {
                type: 2,
                id: 10,
                tagName: "input",
                attributes: {
                  type: "text",
                  value: SYNTHETIC_PII.inputValue,
                  placeholder: SYNTHETIC_PII.placeholder,
                },
                childNodes: [],
              },
              {
                type: 2,
                id: 11,
                tagName: "img",
                attributes: {
                  src: SYNTHETIC_PII.imageUrl,
                  alt: SYNTHETIC_PII.name,
                  width: "32",
                  height: "32",
                },
                childNodes: [],
              },
              {
                type: 5,
                id: 12,
                textContent: `owner: ${SYNTHETIC_PII.email}`,
              },
            ],
          },
        ],
      },
    ],
  };
}

function replayEvents(): unknown[] {
  return [
    {
      type: 4,
      timestamp: 1,
      data: {
        href: `https://app.mcpjam.com/servers/${SYNTHETIC_PII.serverName}`,
        width: 1280,
        height: 800,
      },
    },
    {
      type: 2,
      timestamp: 2,
      data: { node: pageNode(), initialOffset: { top: 0, left: 0 } },
    },
    {
      type: 3,
      timestamp: 3,
      data: {
        source: 0,
        texts: [{ id: 9, value: SYNTHETIC_PII.name }],
        attributes: [
          { id: 8, attributes: { title: SYNTHETIC_PII.title, class: "big" } },
        ],
        removes: [{ parentId: 7, id: 12 }],
        adds: [
          {
            parentId: 7,
            nextId: null,
            node: { type: 3, id: 13, textContent: SYNTHETIC_PII.email },
          },
          {
            parentId: 5,
            nextId: null,
            node: { type: 3, id: 14, textContent: ".added { margin: 0 }" },
          },
        ],
      },
    },
    {
      type: 3,
      timestamp: 4,
      data: {
        source: 5,
        id: 10,
        text: SYNTHETIC_PII.inputValue,
        isChecked: false,
      },
    },
    {
      type: 3,
      timestamp: 5,
      data: { source: 2, type: 2, id: 10, x: 10, y: 20 },
    },
    {
      type: 3,
      timestamp: 6,
      data: { source: 9, id: 11, type: 0, commands: [] },
    },
    {
      type: 6,
      timestamp: 7,
      data: {
        plugin: "rrweb/console@1",
        payload: { level: "log", payload: [SYNTHETIC_PII.consoleMessage] },
      },
    },
    {
      type: 6,
      timestamp: 8,
      data: {
        plugin: "rrweb/network@1",
        payload: {
          requests: [
            {
              name: SYNTHETIC_PII.networkUrl,
              responseBody: SYNTHETIC_PII.networkBody,
            },
          ],
        },
      },
    },
    {
      type: 5,
      timestamp: 9,
      data: {
        tag: "$posthog_config",
        payload: {
          config: {
            api_host: "https://app.mcpjam.com/tlm",
            request_headers: { Authorization: `Bearer ${TOKEN}` },
          },
        },
      },
    },
    {
      type: 5,
      timestamp: 10,
      data: {
        tag: "$pageview",
        payload: {
          href: `https://app.mcpjam.com/p/kd7a8f9g0h1j2k3l4m5n6p7q8r/servers/${SYNTHETIC_PII.serverName}`,
        },
      },
    },
    {
      type: 5,
      timestamp: 11,
      data: { tag: "app-state", payload: { customer: SYNTHETIC_PII.name } },
    },
  ];
}

function snapshotEvent(
  context: ReturnType<typeof stamp> | undefined,
  snapshotData: unknown = replayEvents(),
) {
  return {
    event: "$snapshot",
    properties: {
      token: POSTHOG_PROJECT_KEY,
      distinct_id: "user_1",
      $session_id: "session-1",
      $window_id: "window-1",
      $snapshot_data: snapshotData,
      ...(context ? { [TELEMETRY_CONTEXT_PROPERTY]: context } : {}),
    },
  };
}

function identifyEvent(context: ReturnType<typeof stamp> | undefined) {
  return {
    event: "$identify",
    $set: {
      email: SYNTHETIC_PII.email,
      name: SYNTHETIC_PII.name,
      deployment: "hosted",
    },
    $set_once: { first_name: SYNTHETIC_PII.firstName },
    properties: {
      token: POSTHOG_PROJECT_KEY,
      distinct_id: "user_1",
      $ip: "203.0.113.9",
      $current_url: `https://app.mcpjam.com/servers/${SYNTHETIC_PII.serverName}`,
      $set: { last_name: SYNTHETIC_PII.lastName },
      $el_text: SYNTHETIC_PII.domText,
      $elements_chain: `button.btn:attr__class="btn"attr__title="${SYNTHETIC_PII.title}"nth-child="2"nth-of-type="1"text="${SYNTHETIC_PII.domText}"`,
      ...(context ? { [TELEMETRY_CONTEXT_PROPERTY]: context } : {}),
    },
  };
}

function batch(events: unknown[]) {
  return JSON.stringify({ api_key: POSTHOG_PROJECT_KEY, batch: events });
}

async function post(
  path: string,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
) {
  return await createTestApp().request(`http://localhost:6274${path}`, {
    method: "POST",
    body: body as BodyInit,
    headers: {
      "content-length": String(Buffer.byteLength(body as string)),
      "cf-connecting-ip": "198.51.100.7",
      "x-forwarded-for": "198.51.100.7",
      ...headers,
    },
  });
}

function forwarded(callIndex = 0): {
  url: URL;
  headers: Headers;
  text: string;
  json: any;
} {
  const [input, init] = vi.mocked(fetch).mock.calls[callIndex];
  let text = "";
  if (typeof init?.body === "string") text = init.body;
  else if (init?.body) {
    const bytes = Buffer.from(init.body as Uint8Array);
    text = (
      bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes
    ).toString("utf8");
  }
  return {
    url: new URL(String(input)),
    headers: new Headers(init?.headers),
    text,
    json: text ? JSON.parse(text) : undefined,
  };
}

function gzipLatin1(value: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(value))).toString("latin1");
}

function privacyCounts() {
  loggedEvents.length = 0;
  flushRelayStats();
  const fields = loggedEvents.find((e) => e.name === "relay.stats")?.fields;
  return {
    masked: fields?.privacyMasked ?? 0,
    rejected: fields?.privacyRejected ?? 0,
    unresolved: fields?.privacyUnresolved ?? 0,
    replayDropped: fields?.privacyReplayDropped ?? 0,
  };
}

describe("relay privacy gate", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    flushRelayStats();
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    setTelemetryPolicyQueryForTests(null);
    vi.useRealTimers();
  });

  it("forwards a fully resolved batch as captured, minus the bearer and the stamp, with the client IP", async () => {
    const calls = backend({ [PUBLIC_ORG]: FULL });
    const response = await post(
      "/tlm/s/",
      batch([snapshotEvent(stamp([PUBLIC_ORG]))]),
      { Authorization: `Bearer ${TOKEN}` },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ token: TOKEN, organizationIds: [PUBLIC_ORG] }]);
    const sent = forwarded();
    expect(sent.headers.get("authorization")).toBeNull();
    expect(sent.headers.get("x-forwarded-for")).toBe("198.51.100.7");
    const [event] = sent.json.batch;
    expect(event.properties[TELEMETRY_CONTEXT_PROPERTY]).toBeUndefined();
    expect(event.properties.$geoip_disable).toBeUndefined();
    // Full replay keeps its content — except the relay bearer.
    expect(sent.text).toContain(SYNTHETIC_PII.domText);
    expect(sent.text).not.toContain(TOKEN);
    expect(privacyCounts()).toEqual({
      masked: 0,
      rejected: 0,
      unresolved: 0,
      replayDropped: 0,
    });
  });

  it("keeps person fields for a fully resolved identify", async () => {
    backend({ [PUBLIC_ORG]: FULL });
    await post("/tlm/i/v0/e/", batch([identifyEvent(stamp([PUBLIC_ORG]))]), {
      Authorization: `Bearer ${TOKEN}`,
    });
    const [event] = forwarded().json.batch;
    expect(event.$set.email).toBe(SYNTHETIC_PII.email);
    expect(event.properties.$ip).toBe("203.0.113.9");
  });

  // ── Replay: passed whole or dropped, never rebuilt ──────────────────

  it("does not let a forged permissive label carry replay without a bearer", async () => {
    const calls = backend({ [PUBLIC_ORG]: FULL });
    const response = await post(
      "/tlm/s/",
      batch([snapshotEvent(stamp([PUBLIC_ORG], FULL))]),
    );

    // Unresolved is masked, and this replay was not declared masked.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "telemetry_restricted" });
    expect(calls).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(privacyCounts()).toMatchObject({ rejected: 1 });
  });

  it("does not let a forged permissive label override the backend", async () => {
    backend({ [PRIVATE_ORG]: MASKED });
    const response = await post(
      "/tlm/s/",
      batch([snapshotEvent(stamp([PRIVATE_ORG], FULL))]),
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a bearer the backend refuses (expired, revoked)",
      async () => {
        throw new Error("Authentication required");
      },
    ],
    ["a malformed backend answer", async () => ({ recording: "everything" })],
  ])("treats %s as unresolved", async (_name, query) => {
    setTelemetryPolicyQueryForTests(query as never);
    const response = await post(
      "/tlm/s/",
      batch([
        snapshotEvent(stamp([PUBLIC_ORG], FULL)),
        identifyEvent(stamp([PUBLIC_ORG], FULL)),
      ]),
      { Authorization: `Bearer expired` },
    );
    expect(response.status).toBe(200);
    const sent = forwarded();
    // The full replay is dropped; the rest is restricted.
    expect(sent.json.batch.map((e: { event: string }) => e.event)).toEqual([
      "$identify",
    ]);
    expect(findSyntheticPii(sent.text)).toEqual([]);
    expect(sent.headers.get("x-forwarded-for")).toBeNull();
    expect(privacyCounts()).toEqual({
      masked: 1,
      rejected: 0,
      unresolved: 1,
      replayDropped: 1,
    });
  });

  it("treats a backend that never answers as unresolved", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setTelemetryPolicyQueryForTests(() => new Promise(() => {}));
    const pending = post(
      "/tlm/s/",
      batch([snapshotEvent(stamp([PUBLIC_ORG]))]),
      { Authorization: `Bearer ${TOKEN}` },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards replay the client declared masked as it was recorded, without rebuilding it", async () => {
    backend({ [PRIVATE_ORG]: MASKED });
    // What a masked recorder sends: text already starred, a compressed field
    // left compressed. The relay does not decode, mask or re-encode it.
    const recorded = [
      {
        type: 4,
        timestamp: 1,
        data: { href: "https://app.mcpjam.com/", width: 1, height: 1 },
      },
      {
        type: 2,
        timestamp: 2,
        cv: "2024-10",
        data: gzipLatin1({ node: { type: 0, id: 1, childNodes: [] } }),
      },
      {
        type: 3,
        timestamp: 3,
        data: { source: 0, texts: [{ id: 9, value: "*** ****" }] },
      },
      replayEvents().find(
        (e: any) => e.type === 5 && e.data.tag === "$posthog_config",
      ),
    ];
    const response = await post(
      "/tlm/s/",
      batch([snapshotEvent(stamp([PRIVATE_ORG], MASKED), recorded)]),
      { Authorization: `Bearer ${TOKEN}` },
    );

    expect(response.status).toBe(200);
    const sent = forwarded();
    const [event] = sent.json.batch;
    expect(event.properties[TELEMETRY_CONTEXT_PROPERTY]).toBeUndefined();
    expect(event.properties.$geoip_disable).toBe(true);
    expect(sent.headers.get("x-forwarded-for")).toBeNull();
    // Byte for byte, except the relay bearer in `$posthog_config`.
    expect(event.properties.$snapshot_data.slice(0, 3)).toEqual(
      recorded.slice(0, 3),
    );
    expect(event.properties.$snapshot_data[3].data.payload.config).toEqual({
      api_host: "https://app.mcpjam.com/tlm",
    });
    expect(sent.text).not.toContain(TOKEN);
    expect(privacyCounts()).toMatchObject({ masked: 1, replayDropped: 0 });
  });

  it("lets a restrictive label tighten a permissive backend answer", async () => {
    backend({ [PUBLIC_ORG]: FULL });
    await post("/tlm/s/", batch([snapshotEvent(stamp([PUBLIC_ORG], MASKED))]), {
      Authorization: `Bearer ${TOKEN}`,
    });
    const sent = forwarded();
    expect(sent.json.batch[0].properties.$geoip_disable).toBe(true);
    expect(sent.headers.get("x-forwarded-for")).toBeNull();
  });

  it("drops every replay when the backend has replay off, whatever the client declared, and restricts the rest", async () => {
    backend({ [PRIVATE_ORG]: OFF });
    const response = await post(
      "/tlm/s/",
      batch([
        snapshotEvent(stamp([PRIVATE_ORG], MASKED)),
        snapshotEvent(stamp([PRIVATE_ORG], FULL)),
        identifyEvent(stamp([PRIVATE_ORG], FULL)),
      ]),
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(response.status).toBe(200);
    const sent = forwarded();
    expect(sent.json.batch.map((e: { event: string }) => e.event)).toEqual([
      "$identify",
    ]);
    expect(findSyntheticPii(sent.text)).toEqual([]);
    expect(sent.headers.get("x-forwarded-for")).toBeNull();
    expect(privacyCounts()).toMatchObject({ masked: 1, replayDropped: 2 });
  });

  it("drops replay a client stamped off, even under a permissive answer", async () => {
    backend({ [PUBLIC_ORG]: FULL });
    const response = await post(
      "/tlm/s/",
      batch([snapshotEvent(stamp([PUBLIC_ORG], OFF))]),
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a request with nothing left to forward with a 4xx, which posthog-js does not retry", async () => {
    backend({ [PRIVATE_ORG]: OFF });
    const response = await post(
      "/tlm/s/",
      batch([snapshotEvent(stamp([PRIVATE_ORG], MASKED))]),
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "telemetry_restricted" });
    expect(fetch).not.toHaveBeenCalled();
    expect(privacyCounts()).toMatchObject({ rejected: 1 });
  });

  it("checks every replay of a mixed batch on its own stamp", async () => {
    backend({ [PRIVATE_ORG]: MASKED });
    const response = await post(
      "/tlm/s/",
      batch([
        snapshotEvent(stamp([PRIVATE_ORG], MASKED), [
          { type: 4, timestamp: 1, data: {} },
        ]),
        snapshotEvent(stamp([PRIVATE_ORG], FULL)),
        snapshotEvent(undefined),
      ]),
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(response.status).toBe(200);
    const sent = forwarded();
    expect(sent.json.batch).toHaveLength(1);
    expect(findSyntheticPii(sent.text)).toEqual([]);
    expect(privacyCounts()).toMatchObject({ replayDropped: 2, unresolved: 1 });
  });

  it("gates each event of a mixed-context batch by its own context, and withholds the IP", async () => {
    const calls = backend({ [PUBLIC_ORG]: FULL, [PRIVATE_ORG]: MASKED });
    await post(
      "/tlm/i/v0/e/",
      batch([
        identifyEvent(stamp([PUBLIC_ORG])),
        identifyEvent(stamp([PRIVATE_ORG])),
      ]),
      { Authorization: `Bearer ${TOKEN}` },
    );
    // One question per distinct context.
    expect(calls.map((c) => c.organizationIds)).toEqual(
      expect.arrayContaining([[PUBLIC_ORG], [PRIVATE_ORG]]),
    );
    const sent = forwarded();
    const [open, closed] = sent.json.batch;
    expect(open.$set.email).toBe(SYNTHETIC_PII.email);
    expect(findSyntheticPii(JSON.stringify(closed))).toEqual([]);
    expect(closed.properties.$ip).toBeUndefined();
    expect(closed.properties.$geoip_disable).toBe(true);
    expect(sent.headers.get("x-forwarded-for")).toBeNull();
  });

  it("drops a legacy client's unstamped replay and restricts its other events", async () => {
    backend({ [PUBLIC_ORG]: FULL });
    await post(
      "/relay/s/",
      batch([snapshotEvent(undefined), identifyEvent(undefined)]),
      { Authorization: `Bearer ${TOKEN}` },
    );
    const sent = forwarded();
    expect(sent.json.batch.map((e: { event: string }) => e.event)).toEqual([
      "$identify",
    ]);
    expect(findSyntheticPii(sent.text)).toEqual([]);
    expect(privacyCounts()).toMatchObject({
      masked: 1,
      unresolved: 1,
      replayDropped: 1,
    });
  });

  it("removes identifying person fields, IP and autocapture text from restricted events", async () => {
    await post("/tlm/i/v0/e/", batch([identifyEvent(undefined)]));
    const [event] = forwarded().json.batch;
    expect(event.$set).toEqual({ deployment: "hosted" });
    expect(event.$set_once).toEqual({});
    expect(event.properties.$set).toEqual({});
    expect(event.properties.$ip).toBeUndefined();
    expect(event.properties.$geoip_disable).toBe(true);
    expect(event.properties.$el_text).toBeUndefined();
    expect(event.properties.$elements_chain).toBe(
      'button.btn:attr__class="btn"nth-child="2"nth-of-type="1"',
    );
    expect(event.properties.$current_url).toBe(
      "https://app.mcpjam.com/servers/[name]",
    );
    expect(event.properties.distinct_id).toBe("user_1");
  });

  it("scrubs URLs, hosts and names from every property of a restricted event, $set_once included", async () => {
    const serverUrl = `https://app.mcpjam.com/servers/${SYNTHETIC_PII.serverName}`;
    await post(
      "/tlm/e/",
      batch([
        {
          event: "$web_vitals",
          $set_once: {
            $initial_current_url: serverUrl,
            $initial_referring_domain: "mail.acme-synthetic.example",
            $initial_pathname: `/servers/${SYNTHETIC_PII.serverName}`,
          },
          properties: {
            token: POSTHOG_PROJECT_KEY,
            distinct_id: "user_1",
            project_name: SYNTHETIC_PII.projectName,
            serverName: SYNTHETIC_PII.serverName,
            invitee_email: SYNTHETIC_PII.email,
            $external_click_url: SYNTHETIC_PII.imageUrl,
            $referring_domain: "mail.acme-synthetic.example",
            $session_entry_referring_domain: "$direct",
            $host: "app.mcpjam.com",
            $heatmap_data: {
              [serverUrl]: [{ x: 1, y: 2 }],
              "https://app.mcpjam.com/servers/other-server": [{ x: 3, y: 4 }],
            },
            $web_vitals_LCP_event: { $current_url: serverUrl, value: 1200 },
            $exception_list: [
              {
                value: `Failed to load ${SYNTHETIC_PII.imageUrl}`,
                stacktrace: {
                  frames: [
                    {
                      filename: "https://app.mcpjam.com/assets/index-Bx7k2.js",
                      lineno: 10,
                    },
                  ],
                },
              },
            ],
            failed_request: { url: SYNTHETIC_PII.imageUrl, status: 404 },
            $set_once: { $initial_current_url: serverUrl },
          },
        },
      ]),
    );
    const [event] = forwarded().json.batch;
    expect(findSyntheticPii(JSON.stringify(event))).toEqual([]);
    expect(event.$set_once).toEqual({
      $initial_current_url: "https://app.mcpjam.com/servers/[name]",
      $initial_referring_domain: "[host]",
      $initial_pathname: "/servers/[name]",
    });
    const { properties } = event;
    expect(properties).toMatchObject({
      project_name: "[name]",
      serverName: "[name]",
      invitee_email: "[name]",
      $external_click_url: "https://[host]/[name]/[name]",
      $referring_domain: "[host]",
      $session_entry_referring_domain: "$direct",
      $host: "app.mcpjam.com",
      $heatmap_data: {
        "https://app.mcpjam.com/servers/[name]": [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      },
      $web_vitals_LCP_event: {
        $current_url: "https://app.mcpjam.com/servers/[name]",
        value: 1200,
      },
      failed_request: { url: "https://[host]/[name]/[name]", status: 404 },
      $set_once: {
        $initial_current_url: "https://app.mcpjam.com/servers/[name]",
      },
    });
    expect(properties.$exception_list[0]).toEqual({
      value: "Failed to load https://[host]/[name]/[name]",
      // Code locations stay, so error tracking can resolve the trace.
      stacktrace: {
        frames: [
          {
            filename: "https://app.mcpjam.com/assets/index-Bx7k2.js",
            lineno: 10,
          },
        ],
      },
    });
  });

  it("redacts credential URLs in restricted events with the shared credential sanitizer", async () => {
    const events = CREDENTIAL_PATH_PREFIXES.map((prefix) => ({
      event: "$pageview",
      properties: {
        token: POSTHOG_PROJECT_KEY,
        $current_url: `https://app.mcpjam.com${prefix}kd7a8f9g0h1j2k3l4m5n6p7q8r9s`,
      },
    }));
    await post("/tlm/e/", batch(events));
    const sent = forwarded().json.batch as Array<{
      properties: { $current_url: string };
    }>;
    expect(sent).toHaveLength(CREDENTIAL_PATH_PREFIXES.length);
    const placeholder = scrubSensitiveUrl("/results/x").slice("/results/".length);
    sent.forEach((event) => {
      expect(event.properties.$current_url).not.toContain(
        "kd7a8f9g0h1j2k3l4m5n6p7q8r9s",
      );
      // The secret segment is the shared sanitizer's placeholder. The route
      // words before it may be name-masked themselves (`/connect/server/`).
      expect(event.properties.$current_url.endsWith(`/${placeholder}`)).toBe(
        true,
      );
    });
  });

  it("gates and rewrites GET ingestion", async () => {
    const data = Buffer.from(batch([identifyEvent(undefined)])).toString(
      "base64",
    );
    const response = await createTestApp().request(
      `http://localhost:6274/tlm/e/?data=${encodeURIComponent(data)}&compression=base64&ver=1`,
    );
    expect(response.status).toBe(200);
    const sent = forwarded();
    expect(sent.url.searchParams.has("compression")).toBe(false);
    expect(sent.url.searchParams.get("ver")).toBe("1");
    const payload = sent.url.searchParams.get("data") ?? "";
    expect(findSyntheticPii(payload)).toEqual([]);
    expect(JSON.parse(payload).batch[0].properties.$geoip_disable).toBe(true);
  });

  it("removes the relay bearer from $posthog_config even in a full replay", async () => {
    backend({ [PUBLIC_ORG]: FULL });
    await post("/tlm/s/", batch([snapshotEvent(stamp([PUBLIC_ORG]))]), {
      Authorization: `Bearer ${TOKEN}`,
    });
    const data = forwarded().json.batch[0].properties.$snapshot_data;
    const config = data.find(
      (e: any) => e.type === 5 && e.data.tag === "$posthog_config",
    );
    expect(config.data.payload.config).toEqual({
      api_host: "https://app.mcpjam.com/tlm",
    });
  });

  it("asks about at most eight distinct contexts per request", async () => {
    const calls = backend({});
    const events = Array.from({ length: 9 }, (_, i) =>
      identifyEvent(stamp([`org_${String(i).padStart(24, "0")}`])),
    );
    await post("/tlm/i/v0/e/", batch(events), {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(calls).toHaveLength(0);
    expect(findSyntheticPii(forwarded().text)).toEqual([]);
  });

  // Starts `count` stamped requests one after another, each once the one
  // before has finished reading and is waiting on the backend.
  async function waitingOnBackend(count: number) {
    // The 2s lookup timeout must not fire while the requests are started;
    // vi.waitFor keeps polling on real timers.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const releases: Array<() => void> = [];
    setTelemetryPolicyQueryForTests(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve(FULL));
        }),
    );
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const responses: Array<Promise<Response>> = [];
    for (let i = 0; i < count; i++) {
      responses.push(
        post("/tlm/e/", batch([identifyEvent(stamp([`org_wait_${i}`]))]), auth),
      );
      await vi.waitFor(() => expect(releases).toHaveLength(i + 1), {
        interval: 1,
      });
    }
    // Backend answers arrive spread out, so each is released in turn.
    return async () => {
      const statuses: number[] = [];
      for (let i = 0; i < count; i++) {
        releases[i]();
        statuses.push((await responses[i]).status);
      }
      return statuses;
    };
  }

  it("holds no admission slot while the backend answers", async () => {
    const answerInTurn = await waitingOnBackend(RELAY_MAX_PAYLOAD_CHECKS + 4);

    // Every admission slot is free while those wait on the backend.
    const anonymous = await post("/tlm/e/", batch([identifyEvent(undefined)]));
    expect(anonymous.status).toBe(200);

    expect(new Set(await answerInTurn())).toEqual(new Set([200]));
  });

  it("answers 503 once the policy lookups waiting fill their budget", async () => {
    const answerInTurn = await waitingOnBackend(RELAY_MAX_POLICY_WAITS);

    const refused = await post(
      "/tlm/e/",
      batch([identifyEvent(stamp(["org_one_more"]))]),
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "relay_busy" });

    expect(new Set(await answerInTurn())).toEqual(new Set([200]));
  });

  it("never logs payloads, credentials, names or emails", async () => {
    await post("/tlm/s/", batch([snapshotEvent(undefined)]), {
      Authorization: `Bearer ${TOKEN}`,
    });
    loggedEvents.length = 0;
    flushRelayStats();
    const logged = JSON.stringify(loggedEvents);
    expect(findSyntheticPii(logged)).toEqual([]);
    expect(logged).not.toContain(TOKEN);
  });
});
