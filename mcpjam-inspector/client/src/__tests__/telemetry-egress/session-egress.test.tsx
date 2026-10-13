// @vitest-environment-options {"url": "https://app.mcpjam.com/p/k17abc0123456789abcdefghij/servers"}
/**
 * One browser session, end to end, through the REAL telemetry stack: what
 * leaves for PostHog and Sentry while a visitor uses the app at `full`, walks
 * into every credential page and out again, changes the query and fragment,
 * unloads, and is switched to `masked`.
 *
 * Every payload is decoded all the way down (gzip bodies, beacon blobs, the
 * `cv: "2024-10"` gzipped replay fields, Sentry envelopes and replay
 * segments; `e2e/telemetry/egress.ts`) and searched for the sentinel planted
 * in every corpus URL. Each step also asserts what SHOULD have arrived, so a
 * harness that captured nothing fails.
 *
 * The steps share one session, as a visitor's would, and run in order.
 * Origin `app.mcpjam.com` (the environment option above) rather than jsdom's
 * localhost: it is what the hosted app runs on, and PostHog treats localhost
 * differently.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  apiCorpus,
  assertCorpusComplete,
  compressedReplayEventCount,
  EGRESS_CORPUS,
  GENERIC_EGRESS_URLS,
  LINK_ONLY_EGRESS_URLS,
  RELATIVE_URL_EGRESS,
  pageCorpus,
  posthogEvents,
  posthogReplayEvents,
  RRWEB,
  sentinel,
  sentryReplayEvents,
  recordedText,
} from "../../../../e2e/telemetry/egress";
import {
  bootTelemetryHarness,
  NORMAL_PAGE,
  type TelemetryHarness,
} from "./support/harness";
import { expectArrived, expectNoLeaks } from "./support/expect-egress";

/**
 * Sentry discards a first replay segment shorter than `minReplayDuration`
 * (5s). Steps that must SEE Sentry's replay wait this long before flushing.
 */
const SENTRY_MIN_SEGMENT_MS = 5_500;

const ALL_SHARE_LINKS = [
  ...Object.values(EGRESS_CORPUS),
  ...GENERIC_EGRESS_URLS,
  ...LINK_ONLY_EGRESS_URLS,
] as const;

let harness: TelemetryHarness;

beforeAll(async () => {
  assertCorpusComplete();
  harness = await bootTelemetryHarness();
  // `pending` → `full`: a resolved, authenticated context.
  await harness.setLevel("full");
  await harness.idle(200);
}, 60_000);

// Every step starts from the same place, whatever the previous step left
// behind (a failed assertion included): a normal page, nothing extra on it.
beforeEach(async () => {
  await harness.showShareLinks([]);
  if (window.location.pathname !== NORMAL_PAGE || window.location.search) {
    await harness.navigate(NORMAL_PAGE);
  }
});

describe("at `full`, on a normal page", () => {
  it("share links shown as text, href and iframe src stay out of every payload", async () => {
    const mark = harness.mark();
    await harness.showShareLinks(ALL_SHARE_LINKS);
    await harness.click();
    harness.posthog.capture("egress_custom_event", {
      opened: EGRESS_CORPUS["tester-link"],
      requested: RELATIVE_URL_EGRESS.encodedKey,
      failure: RELATIVE_URL_EGRESS.protocolRelative,
    });
    harness.posthog.captureException(
      new Error(`failed to load ${EGRESS_CORPUS["score-results"]}`),
    );
    harness.Sentry.captureException(
      new Error(`failed GET ${EGRESS_CORPUS["api-score-run"]}`),
    );
    harness.Sentry.captureException(
      new Error(RELATIVE_URL_EGRESS.protocolRelative),
    );
    harness.Sentry.captureException(
      new Error(`failed GET ${RELATIVE_URL_EGRESS.encodedKey}`),
    );
    // Console capture is on at `full` (the remote config turns it on).
    console.info("[egress] copied", EGRESS_CORPUS["tester-link"]);
    await harness.idle(SENTRY_MIN_SEGMENT_MS);
    await harness.flush();

    const scan = harness.scanSince(mark);
    expectNoLeaks(scan, "share links at full");
    expectArrived(scan, "share links at full", {
      posthogEvents: ["egress_custom_event", "$autocapture", "$exception"],
      posthogFullSnapshot: true,
      sentryItems: ["event"],
      sentryFullSnapshot: true,
    });
    // The share links were recorded — scrubbed, not dropped: proof that the
    // full profile records the page.
    expect(recordedText(posthogReplayEvents(scan.decoded))).toContain(
      "https://app.mcpjam.com/results/[redacted]",
    );
    // Unpacked: both profiles turn posthog-js's per-event gzip off, so
    // `before_send` can scrub the stylesheet text rrweb masks nowhere. A
    // packed DOM event would drop its whole batch.
    expect(compressedReplayEventCount(scan.decoded)).toBe(0);
    // The console line arrived too, with its credential scrubbed.
    expectArrived(scan, "share links at full", {
      posthogPlugins: ["rrweb/console@1"],
    });
    const consoleEvents = posthogReplayEvents(scan.decoded).filter(
      (event) =>
        event.type === RRWEB.Plugin &&
        JSON.stringify(event.data).includes("rrweb/console@1"),
    );
    expect(JSON.stringify(consoleEvents)).toContain(
      "/user-testing/acme-study/[redacted]",
    );
  }, 60_000);
});

describe("SPA navigation onto every credential page and back", () => {
  it("records nothing of a credential page, before, during or after", async () => {
    const mark = harness.mark();
    for (const [id, url] of pageCorpus()) {
      await harness.navigate(url);
      await harness.click();
      harness.posthog.capture("send_message", {
        location: "chat_tab",
        multi_model_count: 2,
        route: id,
      });
      harness.Sentry.captureException(new Error(`failed on ${url}`));
      console.info("[egress] on", window.location.href);
      await harness.navigate(NORMAL_PAGE);
      await harness.click();
    }
    await harness.idle(SENTRY_MIN_SEGMENT_MS);
    await harness.flush();

    const scan = harness.scanSince(mark);
    expectNoLeaks(scan, "SPA navigation");
    expectArrived(scan, "SPA navigation", {
      posthogEvents: ["send_message", "$autocapture"],
      posthogFullSnapshot: true,
      sentryItems: ["event", "transaction"],
      sentryFullSnapshot: true,
    });
    // Analytics are not blocked on credential pages, only scrubbed: one event
    // per page arrived.
    const routes = posthogEvents(scan.decoded).filter(
      (event) => event.event === "send_message",
    );
    expect(routes).toHaveLength(pageCorpus().length);
    expect(routes.every((event) => event.properties.route === undefined)).toBe(
      true,
    );
  }, 90_000);
});

describe("a secret query key or fragment on a normal page", () => {
  it("records neither the query nor the fragment", async () => {
    const mark = harness.mark();
    await harness.navigate(`${NORMAL_PAGE}?code=${sentinel("querycode")}`);
    await harness.click();
    harness.posthog.capture("send_message", { location: "chat_tab" });
    await harness.navigate(NORMAL_PAGE);
    await harness.click();

    // A fragment change is not a router navigation: `hashchange`/`popstate`
    // only, which the guard's capture-phase listeners must catch.
    await harness.setHash(`#token=${sentinel("hashtoken")}`);
    await harness.click();
    harness.posthog.capture("edit_message", { location: "chat_tab" });
    await harness.setHash("");
    await harness.navigate(NORMAL_PAGE);
    await harness.click();

    // And the app's own API calls carrying credentials, on a normal page.
    for (const [, url] of apiCorpus()) await fetch(url);
    for (const url of GENERIC_EGRESS_URLS) await fetch(url);
    await harness.idle(SENTRY_MIN_SEGMENT_MS);
    await harness.flush();

    const scan = harness.scanSince(mark);
    expectNoLeaks(scan, "query and fragment");
    expectArrived(scan, "query and fragment", {
      posthogEvents: ["send_message", "edit_message"],
      posthogFullSnapshot: true,
      sentryFullSnapshot: true,
    });
  }, 60_000);
});

describe("a buffered unload on a normal page", () => {
  it("ships what was buffered by beacon, and nothing planted in it", async () => {
    // Unloading ON a credential page is a cold-load test
    // (`cold-load-*.test.tsx`); here the buffer holds a normal page's replay
    // and events that carry credential URLs in their properties.
    const mark = harness.mark();
    await harness.click();
    harness.posthog.capture("egress_before_unload", {
      next: EGRESS_CORPUS["bench-results"],
      referrer: `https://app.mcpjam.com${EGRESS_CORPUS["workos-callback"]}`,
    });
    console.info("[egress] leaving for", EGRESS_CORPUS["conformance-shared"]);
    // No waiting: the tab closes with the request queue and the replay
    // buffer still full.
    await harness.unload();

    const scan = harness.scanSince(mark);
    expectNoLeaks(scan, "unload");
    expectArrived(scan, "unload", {
      posthogEvents: ["egress_before_unload", "$autocapture", "$snapshot"],
    });
    expect(
      scan.decoded.some((entry) => entry.request.transport === "sendBeacon"),
      "the unload flush must leave by sendBeacon",
    ).toBe(true);
    // A bfcache restore: the session carries on for the next step.
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
  }, 60_000);
});

describe("switching from full to strict", () => {
  it("stops both replays while approved diagnostics still arrive", async () => {
    const mark = harness.mark();
    await harness.setLevel("masked");
    await harness.showShareLinks(ALL_SHARE_LINKS);
    await harness.click();
    harness.posthog.capture("send_message", {
      location: "chat_tab",
      multi_model_count: 2,
      prompt: sentinel("strictprompt"),
    });
    harness.posthog.capture("unknown", { prompt: sentinel("unknownprompt") });
    harness.posthog.captureException(new Error(sentinel("posthogerror")));
    harness.Sentry.captureException(new TypeError(sentinel("sentryerror")));
    await harness.idle(200);
    await harness.flush();
    const scan = harness.scanSince(mark);
    expectNoLeaks(scan, "strict");
    expectArrived(scan, "strict", {
      posthogEvents: ["send_message"],
      sentryItems: ["event"],
    });
    expect(posthogReplayEvents(scan.decoded)).toEqual([]);
    expect(sentryReplayEvents(scan.decoded)).toEqual([]);
    expect(
      posthogEvents(scan.decoded).some((event) =>
        ["unknown", "$exception", "$autocapture"].includes(event.event),
      ),
    ).toBe(false);
    const product = posthogEvents(scan.decoded).find(
      (event) => event.event === "send_message",
    );
    expect(product?.properties.multi_model_count).toBe(2);
    expect(JSON.stringify(scan.decoded)).not.toContain("strictprompt");
  }, 60_000);
});
