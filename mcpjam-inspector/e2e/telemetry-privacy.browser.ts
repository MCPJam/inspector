import { expect, test, type Page } from "@playwright/test";
import { gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import {
  findSyntheticPii,
  SYNTHETIC_PII,
} from "../shared/__tests__/fixtures/telemetry-pii";
import { CREDENTIAL_PATH_PREFIXES } from "../shared/credential-url";
import { TELEMETRY_CONTEXT_PROPERTY } from "../shared/telemetry-privacy";
import {
  HARNESS_ACTOR_ID,
  HARNESS_PRIVATE_ORG,
  HARNESS_PUBLIC_ORG,
  HARNESS_RELAY_TOKEN,
  HARNESS_RESULT_TOKEN,
  HARNESS_UNMASKED_MARKER,
} from "./fixtures/telemetry-privacy/constants";

/**
 * What the app's telemetry would send, decoded down to its last compressed
 * field, under a private context and under a verified non-private one.
 *
 * Both transports are intercepted in the browser: PostHog's (the same-origin
 * `/tlm` relay) and Sentry's (its ingest host). The strict run must send
 * NONE of the synthetic personal data — DOM text, inputs, attributes, image
 * URLs, console output, network bodies, names or emails — while still
 * sending useful product counts and structured errors. The full run is the positive control, so
 * "nothing was recorded" can never pass as a privacy guarantee.
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
  // capture on. Strict policy must prevent either recorder from starting.
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

async function collectStrict(captured: Captured) {
  await expect
    .poll(
      () =>
        sentryItems(captured, "event").length > 0 &&
        captured.posthog
          .flatMap((r) => posthogEvents(r.json))
          .some((e) => e.event === "send_message"),
      { timeout: 30_000 },
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
  test("a private context sends useful strict diagnostics and no replay or personal data", async ({
    page,
  }) => {
    const captured = await intercept(page);
    await page.goto("/?privacy=strict");
    await exercise(page);
    await collectStrict(captured);
    await page.waitForTimeout(3_000);

    const text = allPayloadText(captured);
    if (process.env.TELEMETRY_DUMP)
      writeFileSync(process.env.TELEMETRY_DUMP, text);
    expect(findSyntheticPii(text)).toEqual([]);
    expect(text).not.toContain(HARNESS_RELAY_TOKEN);
    expect(snapshotEvents(captured)).toEqual([]);
    expect(sentryItems(captured, "replay_recording")).toEqual([]);
    expect(sentryItems(captured, "replay_event")).toEqual([]);
    const events = captured.posthog.flatMap((r) => posthogEvents(r.json));
    const product = events.find((e) => e.event === "send_message");
    expect(product?.properties).toMatchObject({
      location: "chat_tab",
      multi_model_count: 2,
    });
    for (const event of events) {
      expect(event.properties[TELEMETRY_CONTEXT_PROPERTY]).toMatchObject({
        v: 2,
        o: [HARNESS_PRIVATE_ORG],
        r: "off",
        i: "id_only",
        c: "strict",
      });
    }
    for (const request of captured.posthog) {
      expect(request.headers.authorization).toBe(
        `Bearer ${HARNESS_RELAY_TOKEN}`,
      );
    }
    const error = JSON.parse(
      sentryItems(captured, "event")[0].payload.toString("utf8"),
    );
    expect(error.user).toEqual({ id: HARNESS_ACTOR_ID });
  });

  test("an organization with replay off records nothing, while analytics and errors still arrive", async ({
    page,
  }) => {
    const captured = await intercept(page);
    await page.goto("/?privacy=off");
    await exercise(page);

    // Positive control: the transports are live, so "no replay" below is
    // the policy, not a page that never sent anything.
    await expect
      .poll(
        () =>
          sentryItems(captured, "event").length > 0 &&
          captured.posthog
            .flatMap((r) => posthogEvents(r.json))
            .some((e) => e.event === "send_message"),
        { timeout: 45_000, intervals: [500] },
      )
      .toBe(true);
    // Give a recorder that wrongly started time to flush.
    await page.waitForTimeout(3_000);

    expect(snapshotEvents(captured)).toEqual([]);
    expect(sentryItems(captured, "replay_recording")).toEqual([]);
    expect(sentryItems(captured, "replay_event")).toEqual([]);

    const text = allPayloadText(captured);
    expect(findSyntheticPii(text)).toEqual([]);
    expect(text).not.toContain(HARNESS_RELAY_TOKEN);

    const events = captured.posthog.flatMap((r) => posthogEvents(r.json));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.properties[TELEMETRY_CONTEXT_PROPERTY]).toMatchObject({
        o: [HARNESS_PRIVATE_ORG],
        v: 2,
        r: "off",
        i: "id_only",
        c: "strict",
      });
    }
    const errorEvent = JSON.parse(
      sentryItems(captured, "event")[0].payload.toString("utf8"),
    );
    expect(errorEvent.user).toEqual({ id: HARNESS_ACTOR_ID });
  });

  test("a first visit whose policy never arrives records nothing, while analytics and errors still arrive", async ({
    page,
  }) => {
    const captured = await intercept(page);
    await page.goto("/?privacy=pending");
    await exercise(page);
    await expect
      .poll(
        () =>
          sentryItems(captured, "event").length > 0 &&
          captured.posthog
            .flatMap((r) => posthogEvents(r.json))
            .some((e) => e.event === "send_message"),
        { timeout: 45_000, intervals: [500] },
      )
      .toBe(true);
    // Well past any timeout that could have started a recorder on its own,
    // then another error that would flush a buffered Sentry replay.
    await page.waitForTimeout(11_000);
    await page.evaluate(() => (window as any).__harness.fail());
    await page.waitForTimeout(3_000);

    expect(snapshotEvents(captured)).toEqual([]);
    expect(sentryItems(captured, "replay_recording")).toEqual([]);
    expect(sentryItems(captured, "replay_event")).toEqual([]);
    expect(findSyntheticPii(allPayloadText(captured))).toEqual([]);
    for (const event of captured.posthog.flatMap((r) =>
      posthogEvents(r.json),
    )) {
      expect(event.properties[TELEMETRY_CONTEXT_PROPERTY]).toMatchObject({
        r: "off",
        c: "strict",
        i: "id_only",
      });
    }
  });

  test("full → strict stops replay and keeps sanitized diagnostics", async ({
    page,
  }) => {
    const captured = await intercept(page);
    await page.goto("/?privacy=full");
    await exercise(page);
    await collect(page, captured);
    expect(JSON.stringify(snapshotEvents(captured))).toContain(
      SYNTHETIC_PII.domText,
    );
    await page.evaluate(() => (window as any).__harness.appendMarker());
    await page.waitForTimeout(400);
    await page.evaluate(() => (window as any).__harness.tighten());
    await page.waitForTimeout(500);
    const after: Captured = { posthog: [], sentry: [] };
    const posthogMark = captured.posthog.length;
    const sentryMark = captured.sentry.length;
    await page.evaluate(() => {
      (window as any).__harness.capture();
      (window as any).__harness.fail("failure after policy tightens");
    });
    await expect
      .poll(
        () => {
          after.posthog = captured.posthog.slice(posthogMark);
          after.sentry = captured.sentry.slice(sentryMark);
          return (
            after.posthog.some((r) =>
              posthogEvents(r.json).some((e) => e.event === "send_message"),
            ) && sentryItems(after, "event").length > 0
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await page.waitForTimeout(3_000);
    after.posthog = captured.posthog.slice(posthogMark);
    after.sentry = captured.sentry.slice(sentryMark);
    expect(snapshotEvents(after)).toEqual([]);
    expect(sentryItems(after, "replay_recording")).toEqual([]);
    expect(sentryItems(after, "replay_event")).toEqual([]);
    expect(findSyntheticPii(allPayloadText(after))).toEqual([]);
    expect(allPayloadText(after)).not.toContain(HARNESS_UNMASKED_MARKER);
  });

  test("a share-link page records no replay, even with a full answer for the viewer", async ({
    page,
  }) => {
    const captured = await intercept(page);
    await page.goto("/?privacy=full&shared=1");
    await exercise(page);
    await expect
      .poll(
        () =>
          sentryItems(captured, "event").length > 0 &&
          captured.posthog
            .flatMap((r) => posthogEvents(r.json))
            .some((e) => e.event === "send_message"),
        { timeout: 45_000, intervals: [500] },
      )
      .toBe(true);
    await page.waitForTimeout(3_000);

    expect(snapshotEvents(captured)).toEqual([]);
    expect(sentryItems(captured, "replay_recording")).toEqual([]);
    expect(sentryItems(captured, "replay_event")).toEqual([]);
    // Share contexts restrict both identity and content.
    const text = allPayloadText(captured);
    expect(findSyntheticPii(text)).toEqual([]);
    for (const needle of [
      SYNTHETIC_PII.domText,
      SYNTHETIC_PII.serverName,
      SYNTHETIC_PII.organizationName,
      SYNTHETIC_PII.title,
      SYNTHETIC_PII.inputValue,
    ]) {
      expect(text).not.toContain(needle);
    }
    // Stamped off, so the relay drops any replay from this page as well.
    const events = captured.posthog.flatMap((r) => posthogEvents(r.json));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.properties[TELEMETRY_CONTEXT_PROPERTY]).toMatchObject({
        v: 2,
        r: "off",
        i: "id_only",
        c: "strict",
      });
    }
  });

  test("a credential URL is redacted by the shared credential sanitizer and never recorded", async ({
    page,
  }) => {
    const captured = await intercept(page);
    await page.goto("/?privacy=strict");
    await exercise(page, { namedPage: false });
    await collectStrict(captured);
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
            .some((e) => e.event === "edit_message"),
        { timeout: 20_000 },
      )
      .toBe(true);
    const navigated = captured.posthog
      .flatMap((r) => posthogEvents(r.json))
      .find((e) => e.event === "edit_message");
    expect(navigated?.properties.location).toBe("chat_tab");
    expect(navigated?.properties.$current_url).toBeUndefined();
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
    // The same page sends visible content when its policy permits replay.
    expect(replay).toContain(SYNTHETIC_PII.domText);
    const events = captured.posthog.flatMap((r) => posthogEvents(r.json));
    for (const event of events) {
      expect(event.properties[TELEMETRY_CONTEXT_PROPERTY]).toMatchObject({
        o: [HARNESS_PUBLIC_ORG],
        v: 2,
        r: "full",
        i: "full",
        c: "full",
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
