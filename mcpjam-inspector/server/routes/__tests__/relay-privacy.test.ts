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

import relayRoutes, { flushRelayStats, relayBodyLimit } from "../relay.js";
import { POSTHOG_PROJECT_KEY } from "../../utils/analytics.js";
import { setTelemetryPolicyQueryForTests } from "../../services/telemetry-privacy-policy.js";
import {
  encodeCaptureContext,
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
    return policies.some((p) => p.recording === "masked")
      ? MASKED
      : policies.length > 0
        ? FULL
        : MASKED;
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
  const text =
    typeof init?.body === "string"
      ? init.body
      : new TextDecoder().decode(init?.body as never);
  return {
    url: new URL(String(input)),
    headers: new Headers(init?.headers),
    text,
    json: text ? JSON.parse(text) : undefined,
  };
}

/** Everything a forwarded payload says, compressed fields decoded. */
function decodedText(value: unknown): string {
  return JSON.stringify(value, (_key, field) => {
    if (typeof field === "string" && field.startsWith("\u001f\u008b")) {
      return JSON.parse(
        gunzipSync(Buffer.from(field, "latin1")).toString("utf8"),
      );
    }
    return field;
  });
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
    expect(privacyCounts()).toEqual({ masked: 0, rejected: 0, unresolved: 0 });
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

  it("does not let a forged permissive label authorize full capture without a bearer", async () => {
    const calls = backend({ [PUBLIC_ORG]: FULL });
    const response = await post(
      "/tlm/s/",
      batch([snapshotEvent(stamp([PUBLIC_ORG], FULL))]),
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(0);
    const sent = forwarded();
    expect(findSyntheticPii(decodedText(sent.json))).toEqual([]);
    expect(sent.headers.get("x-forwarded-for")).toBeNull();
    expect(sent.headers.get("x-real-ip")).toBeNull();
    expect(privacyCounts()).toEqual({ masked: 1, rejected: 0, unresolved: 1 });
  });

  it("does not let a forged permissive label override the backend", async () => {
    backend({ [PRIVATE_ORG]: MASKED });
    await post("/tlm/s/", batch([snapshotEvent(stamp([PRIVATE_ORG], FULL))]), {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(findSyntheticPii(decodedText(forwarded().json))).toEqual([]);
    expect(privacyCounts()).toMatchObject({ masked: 1, unresolved: 0 });
  });

  it("lets a restrictive label tighten a permissive backend answer", async () => {
    backend({ [PUBLIC_ORG]: FULL });
    await post("/tlm/s/", batch([snapshotEvent(stamp([PUBLIC_ORG], MASKED))]), {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(findSyntheticPii(decodedText(forwarded().json))).toEqual([]);
  });

  it("treats a bearer the backend refuses (expired, revoked) as unresolved", async () => {
    setTelemetryPolicyQueryForTests(async () => {
      throw new Error("Authentication required");
    });
    await post("/tlm/s/", batch([snapshotEvent(stamp([PUBLIC_ORG]))]), {
      Authorization: `Bearer expired`,
    });
    expect(findSyntheticPii(decodedText(forwarded().json))).toEqual([]);
    expect(privacyCounts()).toEqual({ masked: 1, rejected: 0, unresolved: 1 });
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
    expect(response.status).toBe(200);
    expect(findSyntheticPii(decodedText(forwarded().json))).toEqual([]);
  });

  it("treats a malformed backend answer as unresolved", async () => {
    setTelemetryPolicyQueryForTests(async () => ({ recording: "everything" }));
    await post("/tlm/s/", batch([snapshotEvent(stamp([PUBLIC_ORG]))]), {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(findSyntheticPii(decodedText(forwarded().json))).toEqual([]);
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

  it("masks a legacy client's unstamped events", async () => {
    backend({ [PUBLIC_ORG]: FULL });
    await post(
      "/relay/s/",
      batch([snapshotEvent(undefined), identifyEvent(undefined)]),
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(findSyntheticPii(decodedText(forwarded().json))).toEqual([]);
    expect(privacyCounts()).toMatchObject({ masked: 1, unresolved: 1 });
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
    sent.forEach((event, index) => {
      expect(event.properties.$current_url).not.toContain(
        "kd7a8f9g0h1j2k3l4m5n6p7q8r9s",
      );
      expect(event.properties.$current_url).toContain(
        scrubSensitiveUrl(`${CREDENTIAL_PATH_PREFIXES[index]}token`).replace(
          /token$/,
          "",
        ),
      );
    });
  });

  it("masks replay text, inputs and attributes, blocks media, and drops console, network and canvas recordings", async () => {
    await post("/tlm/s/", batch([snapshotEvent(undefined)]));
    const [event] = forwarded().json.batch;
    const data = event.properties.$snapshot_data as any[];
    const text = decodedText(data);
    expect(findSyntheticPii(text)).toEqual([]);
    expect(text).not.toContain(TOKEN);
    // Console, network and canvas recordings are gone; so is app-state.
    expect(data.some((e) => e.type === 6)).toBe(false);
    expect(data.some((e) => e.type === 3 && e.data.source === 9)).toBe(false);
    expect(data.some((e) => e.type === 5 && e.data.tag === "app-state")).toBe(
      false,
    );
    // Layout survives: tags, classes, kept attributes, CSS under <style>.
    const snapshot = data.find((e) => e.type === 2);
    const html = snapshot.data.node.childNodes[1];
    const style = html.childNodes[0].childNodes[0];
    expect(style.childNodes[0].textContent).toBe(".row { color: red; }");
    const body = html.childNodes[1];
    const [h1, input, img, comment] = body.childNodes;
    expect(h1.attributes).toEqual({
      class: "title",
      title: "***",
      "data-state": "open",
    });
    expect(h1.childNodes[0].textContent).toMatch(/^[* ]+$/);
    expect(input.attributes.type).toBe("text");
    expect(input.attributes.value).toBe("***");
    expect(img).toMatchObject({
      tagName: "img",
      needBlock: true,
      childNodes: [],
      attributes: { rr_width: "32px", rr_height: "32px" },
    });
    expect(comment.textContent).toMatch(/^[*\s]*$/);
    // Incremental data: masked text and inputs, CSS added to a known
    // <style> kept, interactions intact.
    const mutation = data.find((e) => e.type === 3 && e.data.source === 0);
    expect(mutation.data.adds[1].node.textContent).toBe(".added { margin: 0 }");
    const input5 = data.find((e) => e.type === 3 && e.data.source === 5);
    expect(input5.data.text).toMatch(/^\*+$/);
    expect(data.some((e) => e.type === 3 && e.data.source === 2)).toBe(true);
    const meta = data.find((e) => e.type === 4);
    expect(meta.data.href).toBe("https://app.mcpjam.com/servers/[name]");
    const pageview = data.find(
      (e) => e.type === 5 && e.data.tag === "$pageview",
    );
    expect(pageview.data.payload.href).toBe(
      "https://app.mcpjam.com/p/kd7a8f9g0h1j2k3l4m5n6p7q8r/servers/[name]",
    );
  });

  it("decodes, masks and re-encodes posthog-js compressed snapshots and mutations", async () => {
    const [meta, full, mutation] = replayEvents() as any[];
    const compressed = [
      meta,
      { ...full, cv: "2024-10", data: gzipLatin1(full.data) },
      {
        ...mutation,
        cv: "2024-10",
        data: {
          source: 0,
          texts: gzipLatin1(mutation.data.texts),
          attributes: gzipLatin1(mutation.data.attributes),
          removes: gzipLatin1(mutation.data.removes),
          adds: gzipLatin1(mutation.data.adds),
        },
      },
    ];
    const body = gzipSync(batch([snapshotEvent(undefined, compressed)]));
    const response = await post("/tlm/s/?compression=gzip-js", body);

    expect(response.status).toBe(200);
    const sent = forwarded();
    expect(sent.url.searchParams.has("compression")).toBe(false);
    const data = sent.json.batch[0].properties.$snapshot_data;
    // Still compressed the way posthog-js compresses, so the player reads it.
    expect(data[1].cv).toBe("2024-10");
    expect(typeof data[1].data).toBe("string");
    expect(typeof data[2].data.adds).toBe("string");
    const decoded = decodedText(data);
    expect(findSyntheticPii(decoded)).toEqual([]);
    expect(decoded).toContain('"tagName":"h1"');
    expect(decoded).toContain(".row { color: red; }");
  });

  it.each([
    ["an unknown compression version", [{ type: 2, cv: "2031-01", data: "x" }]],
    ["snapshot data that is not a list", { type: 2 }],
    [
      "an unknown node type",
      [{ type: 2, data: { node: { type: 99, id: 1 } } }],
    ],
    [
      "a compressed field that does not inflate",
      [{ type: 2, cv: "2024-10", data: "not gzip at all" }],
    ],
    ["an unknown incremental source", [{ type: 3, data: { source: 77 } }]],
    ["an unknown event type", [{ type: 42, data: {} }]],
    [
      "an attribute value of an unknown shape",
      [
        {
          type: 2,
          data: {
            node: {
              type: 2,
              id: 1,
              tagName: "div",
              attributes: { title: { nested: SYNTHETIC_PII.name } },
              childNodes: [],
            },
          },
        },
      ],
    ],
  ])(
    "refuses a restricted replay with %s instead of forwarding it",
    async (_name, data) => {
      const response = await post(
        "/tlm/s/",
        batch([snapshotEvent(undefined, data)]),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "unsupported_replay_payload",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(privacyCounts()).toMatchObject({ rejected: 1 });
    },
  );

  it("refuses an inner compressed field that inflates past the replay budget", async () => {
    const bomb = gzipSync(Buffer.alloc(25 * 1024 * 1024, 0x20)).toString(
      "latin1",
    );
    const response = await post(
      "/tlm/s/",
      batch([
        snapshotEvent(undefined, [{ type: 2, cv: "2024-10", data: bomb }]),
      ]),
    );
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
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
