import { expect, test, type Page } from "@playwright/test";
import { gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import {
  findSyntheticPii,
  SYNTHETIC_PII,
} from "../shared/__tests__/fixtures/telemetry-pii";
import {
  CREDENTIAL_PATH_PREFIXES,
  scrubSensitiveUrl,
} from "../shared/credential-url";
import { TELEMETRY_CONTEXT_PROPERTY } from "../shared/telemetry-privacy";
import {
  HARNESS_ACTOR_ID,
  HARNESS_PRIVATE_ORG,
  HARNESS_PUBLIC_ORG,
  HARNESS_RELAY_TOKEN,
  HARNESS_RESULT_TOKEN,
} from "./fixtures/telemetry-privacy/constants";

/**
 * What the app's telemetry would send, decoded down to its last compressed
 * field, under a private context and under a verified non-private one.
 *
 * Both transports are intercepted in the browser: PostHog's (the same-origin
 * `/tlm` relay) and Sentry's (its ingest host). The masked run must send
 * NONE of the synthetic personal data — DOM text, inputs, attributes, image
 * URLs, console output, network bodies, names or emails — while still
 * sending a useful recording: real layout, real interactions, and an error
 * that points at its replay. The full run is the positive control, so
 * "nothing was recorded" can never pass as "everything was masked".
 */

const POSTHOG_REMOTE_CONFIG = {
  supportedCompression: ["gzip", "gzip-js"],
  hasFeatureFlags: false,
  autocapture_opt_out: false,
  autocaptureExceptions: true,
  captureDeadClicks: true,
  capturePerformance: false,
  analytics: { endpoint: "/i/v0/e/" },
  elementsChainAsString: true,
  // A project configured as permissively as it can be: console and network
  // capture on. The masked profile must override both.
  sessionRecording: {
    endpoint: "/s/",
    consoleLogRecordingEnabled: true,
    recorderVersion: "v2",
    sampleRate: null,
    minimumDurationMilliseconds: 0,
    linkedFlag: null,
    networkPayloadCapture: { recordBody: true, recordHeaders: true },
    urlTriggers: [],
    urlBlocklist: [],
    eventTriggers: [],
    scriptConfig: null,
  },
  heatmaps: false,
  surveys: false,
  siteApps: [],
};

interface Captured {
  posthog: Array<{ url: URL; headers: Record<string, string>; json: unknown }>;
  sentry: Array<{ items: Array<{ header: any; payload: Buffer }> }>;
}

// ── decoding ─────────────────────────────────────────────────────────────

function decodePosthogBody(body: Buffer, url: URL): unknown {
  if (body.length === 0) {
    const data = url.searchParams.get("data");
    return data ? JSON.parse(Buffer.from(data, "base64").toString()) : null;
  }
  if (body[0] === 0x1f && body[1] === 0x8b) {
    return JSON.parse(gunzipSync(body).toString("utf8"));
  }
  const text = body.toString("utf8");
  if (text.startsWith("data=")) {
    const data = decodeURIComponent(text.slice(5).split("&")[0]);
    return JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  }
  return JSON.parse(text);
}

function posthogEvents(json: unknown): Array<Record<string, any>> {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object" && Array.isArray((json as any).batch)) {
    return (json as any).batch;
  }
  return json ? [json as Record<string, any>] : [];
}

/** Every posthog-js partially compressed field, inflated in place. */
function inflateSnapshot(event: any): any {
  if (event?.cv !== "2024-10") return event;
  const inflate = (value: unknown) =>
    typeof value === "string"
      ? JSON.parse(gunzipSync(Buffer.from(value, "latin1")).toString("utf8"))
      : value;
  if (event.type === 2) return { ...event, data: inflate(event.data) };
  if (event.type === 3) {
    const data = { ...event.data };
    for (const field of ["texts", "attributes", "removes", "adds"]) {
      data[field] = inflate(data[field]);
    }
    return { ...event, data };
  }
  return event;
}

function parseEnvelope(body: Buffer): Array<{ header: any; payload: Buffer }> {
  let offset = body.indexOf(0x0a) + 1;
  const items: Array<{ header: any; payload: Buffer }> = [];
  while (offset > 0 && offset < body.length) {
    const end = body.indexOf(0x0a, offset);
    if (end < 0) break;
    const header = JSON.parse(body.subarray(offset, end).toString("utf8"));
    offset = end + 1;
    let payload: Buffer;
    if (typeof header.length === "number") {
      payload = body.subarray(offset, offset + header.length);
      offset += header.length + 1;
    } else {
      const next = body.indexOf(0x0a, offset);
      const stop = next < 0 ? body.length : next;
      payload = body.subarray(offset, stop);
      offset = stop + 1;
    }
    items.push({ header, payload });
  }
  return items;
}

function decodeRecording(payload: Buffer): unknown[] {
  const split = payload.indexOf(0x0a);
  const data = payload.subarray(split + 1);
  for (const inflate of [
    (b: Buffer) => inflateSync(b),
    (b: Buffer) => gunzipSync(b),
    (b: Buffer) => inflateRawSync(b),
    (b: Buffer) => b,
  ]) {
    try {
      return JSON.parse(inflate(data).toString("utf8"));
    } catch {
      // Try the next encoding.
    }
  }
  throw new Error("undecodable Sentry replay recording");
}

// ── capture ──────────────────────────────────────────────────────────────

async function intercept(page: Page): Promise<Captured> {
  const captured: Captured = { posthog: [], sentry: [] };
  await page.route("**/tlm/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (/\/array\/[^/]+\/config\.js$/.test(url.pathname)) {
      const token = url.pathname.split("/")[3];
      return route.fulfill({
        contentType: "application/javascript",
        body: `window._POSTHOG_REMOTE_CONFIG=window._POSTHOG_REMOTE_CONFIG||{};window._POSTHOG_REMOTE_CONFIG[${JSON.stringify(
          token,
        )}]={config:${JSON.stringify(POSTHOG_REMOTE_CONFIG)},siteApps:[]};`,
      });
    }
    if (/\/array\/[^/]+\/config$/.test(url.pathname)) {
      return route.fulfill({ json: POSTHOG_REMOTE_CONFIG });
    }
    if (/^\/tlm\/(?:e|i\/v0\/e|s)\/?$/.test(url.pathname)) {
      captured.posthog.push({
        url,
        headers: request.headers(),
        json: decodePosthogBody(
          request.postDataBuffer() ?? Buffer.alloc(0),
          url,
        ),
      });
      return route.fulfill({ json: { status: 1 } });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.route(/sentry\.io/, async (route) => {
    const body = route.request().postDataBuffer();
    if (body) captured.sentry.push({ items: parseEnvelope(body) });
    return route.fulfill({ json: {} });
  });
  await page.route(`**${SYNTHETIC_PII.networkUrl}`, (route) =>
    route.fulfill({ json: { customer: SYNTHETIC_PII.email } }),
  );
  for (const url of [SYNTHETIC_PII.imageUrl, SYNTHETIC_PII.iconUrl]) {
    await page.route(url, (route) => route.fulfill({ status: 404, body: "" }));
  }
  return captured;
}

/**
 * Drive the page the way a person would, plus the noisy parts. `namedPage`
 * ends on a page whose path is a server's name before the error.
 */
async function exercise(page: Page, { namedPage = true } = {}) {
  await page.waitForFunction(() => (window as any).__harness?.ready === true);
  // Let the recorder take its full snapshot.
  await page.waitForTimeout(1_500);
  await page.getByTestId("harness-button").click();
  await page.getByTestId("pii-input").fill(SYNTHETIC_PII.inputValue);
  await page.evaluate(async () => {
    const harness = (window as any).__harness;
    harness.log();
    await harness.fetchNetwork();
    harness.identifyWithNames();
    harness.capture();
  });
  // A named page: Sentry names the transaction, which error events carry,
  // and the replay's Meta event after the raw path.
  if (namedPage) {
    await page.evaluate(
      (path) => (window as any).__harness.goTo(path),
      `/servers/${SYNTHETIC_PII.serverName}`,
    );
  }
  await page.waitForTimeout(1_000);
  await page.evaluate(() => (window as any).__harness.fail());
}

function snapshotEvents(captured: Captured) {
  return captured.posthog
    .flatMap((request) => posthogEvents(request.json))
    .filter((event) => event.event === "$snapshot")
    .flatMap((event) =>
      ((event.properties.$snapshot_data as unknown[]) ?? []).map(
        inflateSnapshot,
      ),
    );
}

function sentryItems(captured: Captured, type: string) {
  return captured.sentry
    .flatMap((envelope) => envelope.items)
    .filter((item) => item.header.type === type);
}

async function collect(page: Page, captured: Captured) {
  await expect
    .poll(
      () => {
        const replay = snapshotEvents(captured);
        return (
          replay.some((e) => e.type === 2) &&
          replay.some((e) => e.type === 3 && e.data?.source === 2) &&
          sentryItems(captured, "event").length > 0 &&
          sentryItems(captured, "replay_recording").length > 0 &&
          captured.posthog
            .flatMap((r) => posthogEvents(r.json))
            .some((e) => e.event === "$exception")
        );
      },
      { timeout: 45_000, intervals: [500] },
    )
    .toBe(true);
}

/** Everything the transports carried, as text, for the needle search. */
function allPayloadText(captured: Captured): string {
  const posthog = captured.posthog.map((request) =>
    JSON.stringify(
      posthogEvents(request.json).map((event) =>
        event.event === "$snapshot"
          ? {
              ...event,
              properties: {
                ...event.properties,
                $snapshot_data: (
                  (event.properties.$snapshot_data as unknown[]) ?? []
                ).map(inflateSnapshot),
              },
            }
          : event,
      ),
    ),
  );
  const sentry = captured.sentry.flatMap((envelope) =>
    envelope.items.map((item) =>
      item.header.type === "replay_recording"
        ? JSON.stringify(decodeRecording(item.payload))
        : item.payload.toString("utf8"),
    ),
  );
  return [...posthog, ...sentry].join("\n");
}

test.describe("telemetry privacy in the browser", () => {
  test("a private context sends masked, useful telemetry and no personal data", async ({
    page,
  }) => {
    const captured = await intercept(page);
    await page.goto("/?privacy=masked");
    await exercise(page);
    await collect(page, captured);

    // ── nothing personal, anywhere ──
    const text = allPayloadText(captured);
    // TELEMETRY_DUMP=<file> keeps the decoded payloads for inspection.
    if (process.env.TELEMETRY_DUMP) {
      writeFileSync(process.env.TELEMETRY_DUMP, text);
    }
    expect(findSyntheticPii(text)).toEqual([]);
    expect(text).not.toContain(HARNESS_RELAY_TOKEN);

    // ── the relay can check every PostHog event ──
    const events = captured.posthog.flatMap((r) => posthogEvents(r.json));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.properties[TELEMETRY_CONTEXT_PROPERTY]).toMatchObject({
        v: 1,
        o: [HARNESS_PRIVATE_ORG],
        r: "masked",
        i: "id_only",
      });
    }
    for (const request of captured.posthog) {
      expect(request.headers.authorization).toBe(
        `Bearer ${HARNESS_RELAY_TOKEN}`,
      );
      expect(request.url.search).not.toContain(HARNESS_RELAY_TOKEN);
    }

    // ── a useful recording: layout and interaction ──
    const replay = snapshotEvents(captured);
    const full = replay.find((e) => e.type === 2);
    const snapshot = JSON.stringify(full.data.node);
    expect(snapshot).toContain('"tagName":"button"');
    expect(snapshot).toContain("harness-card");
    expect(snapshot).toMatch(/"textContent":"\*{4,}/);
    expect(snapshot).toContain('"rr_width"');
    expect(replay.some((e) => e.type === 3 && e.data.source === 2)).toBe(true);
    // No console or network recording made it into the replay.
    expect(replay.some((e) => e.type === 6)).toBe(false);

    // ── identity: id-only in both products ──
    const identify = events.find((e) => e.event === "$identify");
    expect(identify?.$set?.email).toBeUndefined();
    const errorEvent = JSON.parse(
      sentryItems(captured, "event")[0].payload.toString("utf8"),
    );
    expect(errorEvent.user).toEqual({ id: HARNESS_ACTOR_ID });

    // ── an error points at its replay, in both products ──
    const replayEvents = sentryItems(captured, "replay_event").map((item) =>
      JSON.parse(item.payload.toString("utf8")),
    );
    expect(
      replayEvents.some(
        (replay) =>
          replay.error_ids?.includes(errorEvent.event_id) ||
          replay.replay_id === errorEvent.contexts?.replay?.replay_id ||
          replay.replay_id === errorEvent.tags?.replayId,
      ),
    ).toBe(true);
    const exception = events.find((e) => e.event === "$exception");
    const sessions = new Set(
      events
        .filter((e) => e.event === "$snapshot")
        .map((e) => e.properties.$session_id),
    );
    expect(sessions.has(exception?.properties.$session_id)).toBe(true);
  });

  test("a credential URL is redacted by the shared credential sanitizer and never recorded", async ({
    page,
  }) => {
    const captured = await intercept(page);
    await page.goto("/?privacy=masked");
    await exercise(page, { namedPage: false });
    await collect(page, captured);
    const before = snapshotEvents(captured).length;
    const path = `${CREDENTIAL_PATH_PREFIXES[0]}${HARNESS_RESULT_TOKEN}`;
    await page.evaluate(
      (target) => (window as any).__harness.goTo(target),
      path,
    );
    await expect
      .poll(
        () =>
          captured.posthog
            .flatMap((r) => posthogEvents(r.json))
            .some((e) => e.event === "harness_navigated"),
        { timeout: 20_000 },
      )
      .toBe(true);
    const navigated = captured.posthog
      .flatMap((r) => posthogEvents(r.json))
      .find((e) => e.event === "harness_navigated");
    expect(navigated?.properties.$current_url).toContain(
      scrubSensitiveUrl(path),
    );
    expect(allPayloadText(captured)).not.toContain(HARNESS_RESULT_TOKEN);
    // Recording stopped on the credential page: nothing new after it.
    await page.waitForTimeout(3_000);
    const after = snapshotEvents(captured).filter(
      (e) => e.type === 4 && String(e.data?.href ?? "").includes("/results/"),
    );
    expect(after).toEqual([]);
    expect(snapshotEvents(captured).length).toBeGreaterThanOrEqual(before);
  });

  test("a verified non-private context records in full: the positive control", async ({
    page,
  }) => {
    const captured = await intercept(page);
    await page.goto("/?privacy=full");
    await exercise(page);
    await collect(page, captured);

    const replay = JSON.stringify(snapshotEvents(captured));
    // The same page, the same recorder, unmasked: the masked run's silence
    // is masking, not a recorder that never ran.
    expect(replay).toContain(SYNTHETIC_PII.domText);
    const events = captured.posthog.flatMap((r) => posthogEvents(r.json));
    for (const event of events) {
      expect(event.properties[TELEMETRY_CONTEXT_PROPERTY]).toMatchObject({
        o: [HARNESS_PUBLIC_ORG],
        r: "full",
        i: "full",
      });
    }
    const identify = events.find((e) => e.event === "$identify");
    expect(identify?.$set?.email).toBe(SYNTHETIC_PII.email);
    const errorEvent = JSON.parse(
      sentryItems(captured, "event")[0].payload.toString("utf8"),
    );
    expect(errorEvent.user.email).toBe(SYNTHETIC_PII.email);
    // Sentry Replay masks text at every level; the bearer never leaves.
    expect(allPayloadText(captured)).not.toContain(HARNESS_RELAY_TOKEN);
  });
});
