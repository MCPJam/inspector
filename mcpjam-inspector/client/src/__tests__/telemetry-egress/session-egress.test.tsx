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
  pageCorpus,
  posthogEvents,
  posthogReplayEvents,
  RRWEB,
  sentinel,
  sentryItems,
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
] as const;

let harness: TelemetryHarness;

beforeAll(async () => {
  assertCorpusComplete();
  harness = await bootTelemetryHarness();
  // `pending` → `full`: a signed-out hosted visitor, once auth has loaded.
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
    });
    harness.posthog.captureException(
      new Error(`failed to load ${EGRESS_CORPUS["score-results"]}`),
    );
    harness.Sentry.captureException(
      new Error(`failed GET ${EGRESS_CORPUS["api-score-run"]}`),
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
    // full profile records the page, and that the decoder opened the gzipped
    // mutation that added them.
    expect(recordedText(posthogReplayEvents(scan.decoded))).toContain(
      "https://app.mcpjam.com/results/[redacted]",
    );
    expect(compressedReplayEventCount(scan.decoded)).toBeGreaterThan(0);
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
      harness.posthog.capture("egress_on_credential_page", { route: id });
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
      posthogEvents: ["egress_on_credential_page", "$autocapture"],
      posthogFullSnapshot: true,
      sentryItems: ["event", "transaction"],
      sentryFullSnapshot: true,
    });
    // Analytics are not blocked on credential pages, only scrubbed: one event
    // per page arrived.
    const routes = posthogEvents(scan.decoded)
      .filter((event) => event.event === "egress_on_credential_page")
      .map((event) => event.properties.route);
    expect(new Set(routes)).toEqual(new Set(pageCorpus().map(([id]) => id)));
  }, 90_000);
});

describe("a secret query key or fragment on a normal page", () => {
  it("records neither the query nor the fragment", async () => {
    const mark = harness.mark();
    await harness.navigate(`${NORMAL_PAGE}?code=${sentinel("querycode")}`);
    await harness.click();
    harness.posthog.capture("egress_query_step");
    await harness.navigate(NORMAL_PAGE);
    await harness.click();

    // A fragment change is not a router navigation: `hashchange`/`popstate`
    // only, which the guard's capture-phase listeners must catch.
    await harness.setHash(`#token=${sentinel("hashtoken")}`);
    await harness.click();
    harness.posthog.capture("egress_fragment_step");
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
      posthogEvents: ["egress_query_step", "egress_fragment_step"],
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

describe("switching from `full` to `masked`", () => {
  it("stops Sentry Replay and re-records PostHog fully masked", async () => {
    const mark = harness.mark();
    await harness.setLevel("masked");
    await harness.showShareLinks(ALL_SHARE_LINKS);
    await harness.click();
    harness.posthog.capture("egress_masked_event", {
      opened: EGRESS_CORPUS["tester-link"],
    });
    harness.Sentry.captureException(
      new Error(`masked failure at ${EGRESS_CORPUS["evals-shared"]}`),
    );
    await harness.idle(200);
    await harness.flush();

    const scan = harness.scanSince(mark);
    expectNoLeaks(scan, "masked");
    expectArrived(scan, "masked", {
      posthogEvents: ["egress_masked_event", "$autocapture"],
      posthogFullSnapshot: true,
      sentryItems: ["event"],
    });
    // Everything recorded after the switch is masked: the share-link text
    // never appears, the masking asterisks do. (The restart's full snapshot
    // is the first event of the new recording.)
    const events = posthogReplayEvents(scan.decoded);
    const restart = events.findIndex(
      (event) => event.type === RRWEB.FullSnapshot,
    );
    expect(restart).toBeGreaterThanOrEqual(0);
    const text = recordedText(events.slice(restart));
    expect(text).not.toContain("Share link");
    expect(text).toMatch(/\*{5,}/);
    // Sentry Replay records only at `full`: nothing recorded after the
    // switch. (Its stop flushes the segment recorded BEFORE it, at `full`,
    // which is allowed — so look for the share links, which only exist after,
    // in snapshots and mutations alike.)
    expect(JSON.stringify(sentryReplayEvents(scan.decoded))).not.toContain(
      "share-links",
    );
    expect(
      sentryItems(scan.decoded).filter((item) => item.type === "replay_event")
        .length,
    ).toBeLessThanOrEqual(1);
  }, 60_000);
});
